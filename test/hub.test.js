import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "ai-usage-hub-"));
process.env.AI_USAGE_DATA_DIR = dir;
const { createHub } = await import("../src/hub.js");
const { readAccounts, readReadings } = await import("../src/store.js");
after(() => rmSync(dir, { recursive: true, force: true }));

const HOUR = 3_600_000;
const usage = (utilization) => ({
  five_hour: { utilization, resets_at: new Date(Date.now() + 2 * HOUR).toISOString() },
  seven_day: { utilization: 12, resets_at: new Date(Date.now() + 90 * HOUR).toISOString() },
});
const until = async (check) => {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
};

// A stand-in for the desktop app's sign-in window: it finishes when the test says so.
function fakeClient() {
  const client = {
    pending: null,
    signedOut: false,
    signIn: (partition) => new Promise((resolve, reject) => { client.pending = { partition, resolve, reject }; }),
    fetchUsage: async () => {
      if (client.signedOut) throw Object.assign(new Error("Signed out of Claude"), { code: "signed-out" });
      return usage(30);
    },
  };
  return client;
}

test("signing in inside the app creates an account with its own session and reads it", async () => {
  const client = fakeClient();
  const hub = createHub({ claudeClient: client, antigravity: false });
  hub.startSignIn(null);
  assert.equal(hub.signIn.pending, true);
  assert.throws(() => hub.startSignIn(null), (err) => err.status === 409);

  client.pending.resolve({ email: "me@example.com", orgId: "org-1" });
  await until(() => !hub.signIn.pending);
  const [account] = readAccounts();
  assert.deepEqual([account.provider, account.email, account.orgId], ["claude", "me@example.com", "org-1"]);
  assert.match(account.partition, /^persist:claude-/);
  assert.equal(hub.status[account.id].state, "ok");
  assert.equal(readReadings().at(-1).session.usedPct, 30);
});

test("signing in again reuses the account's session, and a closed window is not an error", async () => {
  const client = fakeClient();
  const hub = createHub({ claudeClient: client, antigravity: false });
  const [account] = readAccounts();
  hub.startSignIn(account.id);
  assert.equal(client.pending.partition, account.partition);
  client.pending.reject(Object.assign(new Error("closed"), { code: "cancelled" }));
  await until(() => !hub.signIn.pending);
  assert.equal(hub.signIn.error, null);
  assert.equal(readAccounts().length, 1);
});

test("an expired in-app session shows as signed out", async () => {
  const client = fakeClient();
  client.signedOut = true;
  const hub = createHub({ claudeClient: client, antigravity: false });
  await hub.pollAppAccounts();
  const [account] = readAccounts();
  assert.equal(hub.status[account.id].state, "signed-out");
});

test("the same email from the extension joins the in-app account instead of duplicating it", () => {
  const hub = createHub({ claudeClient: fakeClient(), antigravity: false });
  const account = hub.receiveClaude({ account: { email_address: "me@example.com" }, usage: usage(55) });
  assert.equal(account.id, readAccounts()[0].id);
  assert.equal(readAccounts().length, 1);
});

test("without the desktop app, signing in inside the app explains why it cannot", () => {
  const hub = createHub({ antigravity: false });
  assert.equal(hub.canSignIn, false);
  assert.throws(() => hub.startSignIn(null), (err) => err.status === 501);
});
