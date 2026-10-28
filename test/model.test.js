import assert from "node:assert/strict";
import { test } from "node:test";
import { ACCOUNTS } from "../public/accounts.js";
import { accountView, calibrate, HOUR, MINUTE, SESSION_MS, summarize } from "../public/model.js";

const NOW = Date.UTC(2026, 9, 28, 12, 0);
const claude = ACCOUNTS.find((a) => a.id === "claude");
const ag1 = ACCOUNTS.find((a) => a.id === "ag1");
const span = [NOW - 24 * HOUR, NOW + 6 * 24 * HOUR];

function snap(accountId, at, sessionPct, resetsAt, weekly = null) {
  return { accountId, at, session: { usedPct: sessionPct, resetsAt }, weekly, source: "test" };
}

test("an open Claude window reports usage, burn rate and projected full time", () => {
  const reset = NOW + 3 * HOUR; // window started at NOW - 2h
  const snaps = [snap("claude", NOW - 30 * MINUTE, 20, reset), snap("claude", NOW, 40, reset)];
  const v = accountView(claude, snaps, NOW, ...span);
  assert.equal(v.session.state, "open");
  assert.equal(v.session.usedPct, 40);
  assert.equal(v.session.burnPerHour, 40); // 20 points in 30 minutes
  assert.equal(v.session.projectedFullAt, NOW + 1.5 * HOUR);
});

test("a slow session that outlasts its window has no projected full time", () => {
  const reset = NOW + HOUR;
  const snaps = [snap("claude", NOW - 30 * MINUTE, 10, reset), snap("claude", NOW, 12, reset)];
  assert.equal(accountView(claude, snaps, NOW, ...span).session.projectedFullAt, null);
});

test("a window whose reset has passed is idle", () => {
  const v = accountView(ag1, [snap("ag1", NOW - 6 * HOUR, 70, NOW - HOUR)], NOW, ...span);
  assert.equal(v.session.state, "idle");
  assert.deepEqual(v.windows.find((w) => w.kind === "past"), { start: NOW - HOUR - SESSION_MS, end: NOW - HOUR, usedPct: 70, kind: "past" });
});

test("calibration learns the weekly cost of a session from paired movement", () => {
  const weekReset = NOW + 3 * 24 * HOUR;
  const snaps = [
    snap("claude", NOW - 9 * HOUR, 0, NOW - 5 * HOUR, { usedPct: 10, resetsAt: weekReset }),
    snap("claude", NOW - 6 * HOUR, 60, NOW - 5 * HOUR, { usedPct: 16, resetsAt: weekReset }),
    snap("claude", NOW - HOUR, 10, NOW + 4 * HOUR, { usedPct: 17, resetsAt: weekReset }),
    snap("claude", NOW, 50, NOW + 4 * HOUR, { usedPct: 21, resetsAt: weekReset }),
  ];
  const c = calibrate(snaps);
  assert.equal(c.ready, true);
  assert.equal(c.observedSessionPct, 100);
  assert.equal(c.weeklyPctPerSession, 10);
  assert.equal(c.sessionsPerWeek, 10);
  const v = accountView(claude, snaps, NOW, ...span);
  assert.ok(Math.abs(v.sessionsLeft - 7.9) < 1e-9);
  // 7.9 sessions minus the 0.5 left in the current one leaves 7 full planned windows and one partial.
  const planned = v.windows.filter((w) => w.start < weekReset && w.kind !== "current" && w.kind !== "past");
  assert.equal(planned.filter((w) => w.kind === "planned").length, 7);
  assert.equal(planned.filter((w) => w.kind === "partial").length, 1);
});

test("calibration waits for enough observed session movement", () => {
  const weekReset = NOW + 3 * 24 * HOUR;
  const snaps = [
    snap("claude", NOW - HOUR, 10, NOW + 4 * HOUR, { usedPct: 17, resetsAt: weekReset }),
    snap("claude", NOW, 30, NOW + 4 * HOUR, { usedPct: 19, resetsAt: weekReset }),
  ];
  assert.deepEqual(calibrate(snaps), { ready: false, observedSessionPct: 20 });
});

test("the planner prefers an open window that would otherwise expire unused", () => {
  const views = [
    accountView(claude, [snap("claude", NOW - 10 * MINUTE, 30, NOW + 2 * HOUR)], NOW, ...span),
    accountView(ag1, [snap("ag1", NOW - 10 * MINUTE, 50, NOW + HOUR)], NOW, ...span),
  ];
  const s = summarize(views, NOW);
  assert.equal(s.suggestion.kind, "use-open");
  assert.equal(s.suggestion.view.account.id, "ag1");
  assert.equal(s.active.account.id, "claude");
});

test("a fresh manual log without a burn rate is not the active session", () => {
  const views = [
    accountView(claude, [snap("claude", NOW - 10 * MINUTE, 30, NOW + 2 * HOUR)], NOW, ...span),
    accountView(ag1, [snap("ag1", NOW - MINUTE, 20, NOW + 4 * HOUR)], NOW, ...span),
  ];
  assert.equal(summarize(views, NOW).active.account.id, "claude");
});

test("the planner waits for the soonest reset when every window is used up", () => {
  const views = [
    accountView(claude, [snap("claude", NOW, 100, NOW + 2 * HOUR)], NOW, ...span),
    accountView(ag1, [snap("ag1", NOW, 98, NOW + HOUR)], NOW, ...span),
  ];
  const s = summarize(views, NOW);
  assert.equal(s.suggestion.kind, "session-wait");
  assert.equal(s.suggestion.view.account.id, "ag1");
  assert.equal(s.suggestion.at, NOW + HOUR);
  assert.equal(s.readyCount, 0);
});
