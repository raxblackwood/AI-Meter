import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "ai-usage-test-"));
process.env.AI_USAGE_DATA_DIR = dir;
const { createApp } = await import("../server.js");
const { createHub } = await import("../src/hub.js");
const { readAccounts } = await import("../src/store.js");

const HOUR = 3_600_000;
const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const report = (email, utilization) => ({
  account: { email_address: email },
  orgId: "org-1",
  usage: {
    five_hour: { utilization, resets_at: new Date(Date.now() + 2 * HOUR).toISOString() },
    seven_day: { utilization: 12, resets_at: new Date(Date.now() + 90 * HOUR).toISOString() },
  },
});

let server;
let port;
before(async () => {
  const hub = createHub({ antigravity: false });
  // The app checks the port in the Host header, so find a free port first.
  const probe = createApp({ hub, port: 0 });
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  port = probe.address().port;
  probe.close();
  server = createApp({ hub, port });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* static file */ }
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test("a report from the browser extension creates the Claude account and records its usage", async () => {
  const res = await call("POST", "/api/connector/claude", report("Me@Example.com", 30), { origin: EXTENSION });
  assert.equal(res.status, 200);
  const state = (await call("GET", "/api/state")).body;
  assert.equal(state.accounts.length, 1);
  const [account] = state.accounts;
  assert.deepEqual([account.provider, account.name, account.email], ["claude", "Claude 1", "me@example.com"]);
  assert.equal(state.status[account.id].state, "ok");
  assert.ok(state.connector.claudeSeenAt);
  assert.match(state.connector.extensionDir, /extension$/);
  assert.equal(state.connector.storeUrl, null, "no store link until the extension is published");
  assert.equal(state.snapshots.find((s) => s.accountId === account.id).session.usedPct, 30);

  // The same email reports again: same account, new reading.
  await call("POST", "/api/connector/claude", report("me@example.com", 45), { origin: EXTENSION });
  const again = (await call("GET", "/api/state")).body;
  assert.equal(again.accounts.length, 1);
  assert.deepEqual(again.snapshots.map((s) => s.session.usedPct), [30, 45]);
});

test("a signed-out report marks that account signed out", async () => {
  await call("POST", "/api/connector/claude", { email: "me@example.com", signedOut: true }, { origin: EXTENSION });
  const state = (await call("GET", "/api/state")).body;
  assert.equal(state.status[state.accounts[0].id].state, "signed-out");
});

test("an extension error is shown until the next good reading", async () => {
  await call("POST", "/api/connector/claude", { email: null, signedOut: false, error: "claude.ai returned 403" }, { origin: EXTENSION });
  assert.equal((await call("GET", "/api/state")).body.connector.error, "claude.ai returned 403");
  await call("POST", "/api/connector/claude", report("me@example.com", 50), { origin: EXTENSION });
  assert.equal((await call("GET", "/api/state")).body.connector.error, null);
});

test("extension reports without an email or limits are rejected", async () => {
  assert.equal((await call("POST", "/api/connector/claude", { usage: {} }, { origin: EXTENSION })).status, 400);
  assert.equal((await call("POST", "/api/connector/claude", { account: { email_address: "a@b.co" }, usage: {} }, { origin: EXTENSION })).status, 400);
});

test("accounts can be renamed, removed and restored", async () => {
  const [account] = readAccounts();
  assert.equal((await call("PATCH", `/api/accounts/${account.id}`, { name: "  Work  " })).body.name, "Work");
  assert.equal((await call("PATCH", `/api/accounts/${account.id}`, { name: "" })).status, 400);
  assert.equal((await call("DELETE", `/api/accounts/${account.id}`)).status, 200);
  assert.equal((await call("GET", "/api/state")).body.accounts.length, 0);
  assert.equal((await call("POST", `/api/accounts/${account.id}/restore`)).status, 200);
  assert.equal((await call("GET", "/api/state")).body.accounts[0].name, "Work");
  assert.equal((await call("DELETE", "/api/accounts/nope")).status, 404);
});

test("only this machine's pages may use the API", async () => {
  assert.equal((await call("GET", "/api/state", null, { host: "evil.example:80" })).status, 403);
  const [account] = readAccounts();
  const cross = await call("DELETE", `/api/accounts/${account.id}`, null, { origin: "https://evil.example" });
  assert.equal(cross.status, 403);
  const same = await call("PATCH", `/api/accounts/${account.id}`, { name: "Work" }, { origin: `http://localhost:${port}` });
  assert.equal(same.status, 200);
  // Extensions may post readings, but not change accounts; websites may do neither.
  assert.equal((await call("DELETE", `/api/accounts/${account.id}`, null, { origin: EXTENSION })).status, 403);
  assert.equal((await call("POST", "/api/connector/claude", report("x@y.co", 1), { origin: "https://evil.example" })).status, 403);
});

test("data from the first version is migrated once", async () => {
  const legacy = mkdtempSync(join(tmpdir(), "ai-usage-legacy-"));
  try {
    writeFileSync(join(legacy, "account-links.json"), JSON.stringify({ "a@x.com": "ag2", "b@x.com": null }));
    writeFileSync(join(legacy, "antigravity-feed.jsonl"), JSON.stringify({ at: 1, email: "a@x.com", session: null, weekly: { usedPct: 100, resetsAt: 9 }, flash: null }) + "\n");
    writeFileSync(join(legacy, "antigravity-latest.json"), JSON.stringify({ "a@x.com": { at: 1, seenAt: 5, session: null, weekly: null } }));
    const { readReadings, readSeen } = await import("../src/store.js");
    const accounts = readAccounts(legacy);
    assert.deepEqual(accounts.map((a) => [a.provider, a.name, a.email]), [["antigravity", "Antigravity 2", "a@x.com"]]);
    assert.equal(readReadings(legacy)[0].accountId, accounts[0].id);
    assert.equal(readSeen(legacy)[accounts[0].id], 5);
    assert.equal(readAccounts(legacy).length, 1);
  } finally {
    rmSync(legacy, { recursive: true, force: true });
  }
});

test("static files are served and path traversal is refused", async () => {
  const page = await call("GET", "/");
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>AI Usage<\/title>/);
  assert.equal((await call("GET", "/..%2Fserver.js")).status, 404);
});
