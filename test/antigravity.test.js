import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ACCOUNTS, ANTIGRAVITY_IDS } from "../public/accounts.js";
import { accountView, HOUR, summarize } from "../public/model.js";
import { createAntigravityCollector, parseCommandLine, toReading } from "../src/antigravity.js";
import { linkEmail, readAntigravityFeed, recordAntigravity } from "../src/store.js";

const NOW = Date.UTC(2026, 9, 28, 12, 0);
const iso = (ms) => new Date(ms).toISOString();
const dirs = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-usage-ag-"));
  dirs.push(dir);
  return dir;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// Shape of a GetUserStatus response, trimmed to the fields the collector reads.
function status(email, models) {
  return {
    userStatus: {
      email,
      userTier: { name: "Google AI Pro" },
      cascadeModelConfigData: { clientModelConfigs: models.map(([label, quotaInfo]) => ({ label, quotaInfo })) },
    },
  };
}

test("parseCommandLine reads the token and port from an Antigravity language server", () => {
  const line = String.raw`"C:\Program Files\Antigravity IDE\resources\bin\language_server.exe" --standalone --https_server_port 62142 --csrf_token abc-123 --app_data_dir antigravity`;
  assert.deepEqual(parseCommandLine(line), { csrfToken: "abc-123", port: 62142 });
  // Port 0 means the server picked its own port, found later from the OS.
  assert.deepEqual(parseCommandLine(line.replace("62142", "0")), { csrfToken: "abc-123", port: null });
  assert.equal(parseCommandLine(String.raw`C:\Windsurf\language_server.exe --https_server_port 1 --csrf_token x`), null);
  assert.equal(parseCommandLine(String.raw`C:\Antigravity\language_server.exe --https_server_port 1`), null);
  assert.equal(parseCommandLine(""), null);
});

test("toReading puts premium in the session and Flash in its own bucket", () => {
  const r = toReading(status("Me@Example.com", [
    ["Gemini 3.8 Flash (High)", { remainingFraction: 0.25, resetTime: iso(NOW + 2 * HOUR) }],
    ["Claude Sonnet 4.6 (Thinking)", { remainingFraction: 0.6, resetTime: iso(NOW + 4 * HOUR) }],
    ["Claude Opus 4.6 (Thinking)", { remainingFraction: 0.4, resetTime: iso(NOW + 4 * HOUR) }],
    ["Gemini 4 Argon", {}],
  ]), NOW);
  assert.equal(r.email, "me@example.com");
  assert.deepEqual(r.session, { usedPct: 60, resetsAt: NOW + 4 * HOUR });
  assert.equal(r.weekly, null);
  assert.deepEqual(r.flash, { usedPct: 75, resetsAt: NOW + 2 * HOUR });
});

test("a missing remainingFraction is zero, and a reset days away is a weekly lockout", () => {
  const r = toReading(status("me@example.com", [
    ["Gemini 3.8 Flash (High)", { resetTime: iso(NOW + 2 * HOUR) }],
    ["Claude Opus 4.6 (Thinking)", { resetTime: iso(NOW + 50 * HOUR) }],
  ]), NOW);
  assert.equal(r.session, null);
  assert.deepEqual(r.weekly, { usedPct: 100, resetsAt: NOW + 50 * HOUR });
  assert.deepEqual(r.flash, { usedPct: 100, resetsAt: NOW + 2 * HOUR });
});

test("a full quota is recorded as no open window", () => {
  const r = toReading(status("me@example.com", [["Claude Opus 4.6", { remainingFraction: 1, resetTime: iso(NOW + 5 * HOUR) }]]), NOW);
  assert.equal(r.session, null);
  assert.equal(r.weekly, null);
  assert.equal(toReading({ userStatus: {} }, NOW), null);
});

test("a locked-out account is not suggested until its lockout ends", () => {
  const ag1 = ACCOUNTS.find((a) => a.id === "ag1");
  const locked = { accountId: "ag1", at: NOW, session: null, weekly: { usedPct: 100, resetsAt: NOW + 50 * HOUR }, flash: null, source: "antigravity" };
  const v = accountView(ag1, [locked], NOW, NOW - 24 * HOUR, NOW + 6 * 24 * HOUR);
  assert.equal(v.exhausted, true);
  const s = summarize([v], NOW);
  assert.equal(s.suggestion.kind, "weekly-wait");
  assert.equal(s.suggestion.at, NOW + 50 * HOUR);
  // Once the lockout has passed, Antigravity has no weekly window to wait on.
  assert.equal(accountView(ag1, [locked], NOW + 51 * HOUR, NOW, NOW + 7 * 24 * HOUR).weekly, null);
});

test("readings are stored by email, linked to free accounts and deduplicated", () => {
  const dir = tempDir();
  const a = { at: NOW, email: "a@x.com", plan: "Google AI Pro", session: { usedPct: 10, resetsAt: NOW + HOUR }, weekly: null, flash: null };
  assert.equal(linkEmail("a@x.com", ANTIGRAVITY_IDS, dir), "ag1");
  assert.equal(linkEmail("b@x.com", ANTIGRAVITY_IDS, dir), "ag2");
  assert.equal(linkEmail("a@x.com", ANTIGRAVITY_IDS, dir), "ag1");
  assert.equal(recordAntigravity(a, dir), true);
  assert.equal(recordAntigravity({ ...a, at: NOW + 60_000 }, dir), false);
  assert.equal(recordAntigravity({ ...a, at: NOW + 120_000, session: { usedPct: 20, resetsAt: NOW + HOUR } }, dir), true);
  const feed = readAntigravityFeed(dir);
  assert.equal(feed.snapshots.length, 2);
  assert.deepEqual(feed.snapshots.map((s) => s.accountId), ["ag1", "ag1"]);
  assert.deepEqual(feed.detected, [{ email: "a@x.com", accountId: "ag1", seenAt: NOW + 120_000, plan: "Google AI Pro" }]);
});

test("the collector reports each account once and rediscovers after a failure", async () => {
  const readings = [];
  let discoveries = 0;
  let fail = false;
  const collector = createAntigravityCollector({
    now: () => NOW,
    discover: async () => {
      discoveries++;
      return [{ ports: [1], csrfToken: "t" }, { ports: [2], csrfToken: "t" }];
    },
    fetchStatus: async () => {
      if (fail) throw new Error("connection refused");
      return status("a@x.com", [["Claude Opus", { remainingFraction: 0.5, resetTime: iso(NOW + HOUR) }]]);
    },
    onReading: (r) => readings.push(r),
  });
  await collector.poll();
  await collector.poll();
  assert.equal(readings.length, 2);
  assert.equal(discoveries, 1);
  assert.equal(collector.status.state, "ok");
  fail = true;
  await collector.poll();
  assert.equal(collector.status.state, "error");
  assert.equal(collector.status.error, "connection refused");
  fail = false;
  await collector.poll();
  assert.equal(discoveries, 2);
});

test("the collector says when Antigravity is not running", async () => {
  const collector = createAntigravityCollector({ now: () => NOW, discover: async () => [], onReading: () => {} });
  await collector.poll();
  assert.equal(collector.status.state, "not-running");
});
