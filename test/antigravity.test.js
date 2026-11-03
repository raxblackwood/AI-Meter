import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { accountView, HOUR, summarize } from "../public/model.js";
import { createAntigravityCollector, parseCommandLine, toReading } from "../src/antigravity.js";
import { accountForIdentity, readAccounts, readReadings, readSeen, recordReading, updateAccount } from "../src/store.js";

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
function status(email, models, planStatus = null) {
  return {
    userStatus: {
      email,
      userTier: { name: "Google AI Pro" },
      planStatus,
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

test("credits and Flash quota keep Antigravity usable when 3rd-party models are locked out", () => {
  const r = toReading(status("me@example.com", [
    ["Gemini 3.8 Flash (High)", { remainingFraction: 1, resetTime: iso(NOW + 2 * HOUR) }],
    ["Claude Opus 4.6 (Thinking)", { resetTime: iso(NOW + 50 * HOUR) }],
  ], { availablePromptCredits: 500, availableFlowCredits: 100 }), NOW);
  assert.equal(r.session, null);
  assert.equal(r.weekly, null);
  assert.deepEqual(r.flash, { usedPct: 0, resetsAt: NOW + 2 * HOUR });
  assert.deepEqual(r.credits, { prompt: 500, flow: 100 });
  assert.deepEqual(r.thirdParty, { usedPct: 100, resetsAt: NOW + 50 * HOUR });

  const ag1 = { id: "ag1", provider: "antigravity", name: "Antigravity 1" };
  const v = accountView(ag1, [{ accountId: "ag1", at: NOW, ...r }], NOW, NOW - 24 * HOUR, NOW + 6 * 24 * HOUR);
  assert.equal(v.exhausted, false);
  assert.equal(v.session.state, "idle");
  assert.deepEqual(v.credits, { prompt: 500, flow: 100 });
  assert.deepEqual(v.thirdParty, { usedPct: 100, resetsAt: NOW + 50 * HOUR });

  const s = summarize([v], NOW);
  assert.equal(s.suggestion.kind, "start-fresh");
  assert.equal(s.suggestion.view.account.id, "ag1");
});

test("RetrieveUserQuotaSummary accurately maps Gemini and Claude limits without false lockouts", () => {
  const statusWithSummary = {
    userStatus: {
      email: "user@example.com",
      userTier: { name: "Google AI Pro" },
      planStatus: { availablePromptCredits: 500, availableFlowCredits: 100 },
    },
    quotaSummary: {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.19, resetTime: iso(NOW + 60 * HOUR) },
            { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.94, resetTime: iso(NOW + 4 * HOUR) },
          ],
        },
        {
          displayName: "Claude and GPT models",
          buckets: [
            { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.47, resetTime: iso(NOW + 110 * HOUR) },
            { bucketId: "3p-5h", window: "5h", remainingFraction: 1, resetTime: iso(NOW + 5 * HOUR) },
          ],
        },
      ],
    },
  };

  const r = toReading(statusWithSummary, NOW);
  assert.equal(r.email, "user@example.com");
  assert.deepEqual(r.session, { usedPct: 6, resetsAt: NOW + 4 * HOUR });
  assert.deepEqual(r.weekly, { usedPct: 81, resetsAt: NOW + 60 * HOUR });
  assert.equal(r.thirdParty, null); // Not locked because remainingFraction is 0.47 > 0
  assert.deepEqual(r.credits, { prompt: 500, flow: 100 });
  assert.equal(r.models.gemini.weekly.remainingPct, 19);
  assert.equal(r.models.gemini.session.remainingPct, 94);
  assert.equal(r.models.claude.weekly.remainingPct, 47);
  assert.equal(r.models.claude.session.remainingPct, 100);
});

test("a locked-out account is not suggested until its lockout ends", () => {
  const ag1 = { id: "ag1", provider: "antigravity", name: "Antigravity 1" };
  const locked = { accountId: "ag1", at: NOW, session: null, weekly: { usedPct: 100, resetsAt: NOW + 50 * HOUR }, flash: null, source: "antigravity" };
  const v = accountView(ag1, [locked], NOW, NOW - 24 * HOUR, NOW + 6 * 24 * HOUR);
  assert.equal(v.exhausted, true);
  // One locked stretch until the unlock, then the first window starts right at the unlock time.
  assert.deepEqual(v.windows.slice(0, 2).map((w) => [w.kind, w.start, w.end]), [
    ["over", NOW, NOW + 50 * HOUR],
    ["planned", NOW + 50 * HOUR, NOW + 55 * HOUR],
  ]);
  const s = summarize([v], NOW);
  assert.equal(s.suggestion.kind, "weekly-wait");
  assert.equal(s.suggestion.at, NOW + 50 * HOUR);
  // Once the lockout has passed, Antigravity has no weekly window to wait on.
  assert.equal(accountView(ag1, [locked], NOW + 51 * HOUR, NOW, NOW + 7 * 24 * HOUR).weekly, null);
});

test("each new Antigravity email becomes its own account, and readings are deduplicated", () => {
  const dir = tempDir();
  const a = accountForIdentity("antigravity", "a@x.com", dir);
  const b = accountForIdentity("antigravity", "b@x.com", dir);
  assert.equal(accountForIdentity("antigravity", "a@x.com", dir).id, a.id);
  assert.deepEqual([a.name, b.name], ["Antigravity 1", "Antigravity 2"]);

  const reading = { at: NOW, session: { usedPct: 10, resetsAt: NOW + HOUR }, weekly: null, flash: null };
  assert.equal(recordReading(a.id, reading, dir), true);
  assert.equal(recordReading(a.id, { ...reading, at: NOW + 60_000 }, dir), false);
  assert.equal(recordReading(a.id, { ...reading, at: NOW + 120_000, session: { usedPct: 20, resetsAt: NOW + HOUR } }, dir), true);
  assert.deepEqual(readReadings(dir).map((r) => r.session.usedPct), [10, 20]);
  assert.equal(readSeen(dir)[a.id], NOW + 120_000);
});

test("a removed Antigravity account stays removed when it is seen again", () => {
  const dir = tempDir();
  const a = accountForIdentity("antigravity", "a@x.com", dir);
  updateAccount(a.id, { removedAt: NOW }, dir);
  const again = accountForIdentity("antigravity", "a@x.com", dir);
  assert.equal(again.id, a.id);
  assert.equal(again.removedAt, NOW);
  assert.equal(readAccounts(dir).length, 1);
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
