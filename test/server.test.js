import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "ai-usage-test-"));
process.env.AI_USAGE_DATA_DIR = dir;
const { createApp } = await import("../server.js");

let server;
let base;
before(async () => {
  server = createApp();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test("statusline.js records rate limits once per change and prints a status", () => {
  const input = JSON.stringify({
    model: { display_name: "Opus 5.5" },
    rate_limits: {
      five_hour: { used_percentage: 37, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      seven_day: { used_percentage: 22, resets_at: Math.floor(Date.now() / 1000) + 86400 },
    },
  });
  const run = () => execFileSync(process.execPath, ["statusline.js"], { input, env: process.env }).toString();
  const out = run();
  run();
  assert.match(out, /^Opus 5\.5 · 5h 37% \(resets .+\) · week 22%$/);
  const lines = readFileSync(join(dir, "claude-feed.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
});

test("statusline.js prints something even without rate limits or valid input", () => {
  const run = (input) => execFileSync(process.execPath, ["statusline.js"], { input, stdio: ["pipe", "pipe", "ignore"] }).toString();
  assert.equal(run(JSON.stringify({ model: { display_name: "Opus 5.5" } })), "Opus 5.5");
  assert.equal(run("not json"), "");
});

test("manual entries can be created, listed, deleted and restored", async () => {
  const resetsAt = Date.now() + 2 * 3600_000;
  const created = await call("POST", "/api/entries", { accountId: "ag2", usedPct: 45, resetsAt });
  assert.equal(created.status, 201);

  let state = await call("GET", "/api/state");
  assert.equal(state.body.entries.length, 1);
  assert.ok(state.body.snapshots.some((s) => s.source === "statusline"));
  assert.ok(state.body.feedSeenAt);

  const removed = await call("DELETE", `/api/entries/${created.body.id}`);
  assert.equal(removed.status, 200);
  const { id, accountId, at } = removed.body;
  const restored = await call("POST", "/api/entries", { id, accountId, at, usedPct: 45, resetsAt });
  assert.deepEqual(restored.body, created.body);
  assert.equal((await call("POST", "/api/entries", { id, accountId, at, usedPct: 45, resetsAt })).status, 409);
});

test("invalid entries are rejected", async () => {
  const resetsAt = Date.now() + 3600_000;
  assert.equal((await call("POST", "/api/entries", { accountId: "nope", usedPct: 1, resetsAt })).status, 400);
  assert.equal((await call("POST", "/api/entries", { accountId: "ag1", usedPct: 101, resetsAt })).status, 400);
  assert.equal((await call("POST", "/api/entries", { accountId: "ag1", usedPct: 5, resetsAt: Date.now() - 1 })).status, 400);
});

test("relinking an Antigravity email swaps with the account's current email", async () => {
  const { relink } = await import("../server.js");
  const known = ["a@x.com", "b@x.com", "c@x.com"];
  assert.deepEqual(relink({ "a@x.com": "ag1", "b@x.com": "ag2" }, "a@x.com", "ag2", known), { "a@x.com": "ag2", "b@x.com": "ag1" });
  assert.deepEqual(relink({ "a@x.com": "ag1" }, "c@x.com", "ag1", known), { "a@x.com": null, "c@x.com": "ag1" });
  assert.deepEqual(relink({ "a@x.com": "ag1" }, "a@x.com", null, known), { "a@x.com": null });
  assert.throws(() => relink({}, "z@x.com", "ag1", known), /Unknown email/);
  assert.throws(() => relink({}, "a@x.com", "claude", known), /Not an Antigravity account/);
});

test("static files are served and path traversal is refused", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>AI Usage<\/title>/);
  assert.equal((await fetch(`${base}/..%2Fserver.js`)).status, 404);
});
