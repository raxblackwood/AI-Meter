import assert from "node:assert/strict";
import { test } from "node:test";
import { badgeFor, initials } from "../public/badge.js";
import { accountView, HOUR } from "../public/model.js";

const NOW = Date.UTC(2026, 9, 29, 12, 0);
const claude = { id: "c", provider: "claude", name: "Claude 1" };
const ag = { id: "a", provider: "antigravity", name: "Antigravity 1" };
const view = (account, snaps) => accountView(account, snaps, NOW, NOW - 6 * HOUR, NOW + 3 * 24 * HOUR);
const snap = (accountId, session, weekly = null) => ({ accountId, at: NOW - 60_000, session, weekly, source: "auto" });

test("the outer ring is the session left and the inner ring the week left", () => {
  const b = badgeFor(view(claude, [snap("c", { usedPct: 57, resetsAt: NOW + 2 * HOUR }, { usedPct: 41, resetsAt: NOW + 90 * HOUR })]), { state: "ok" }, NOW, NOW);
  assert.equal(b.state, "ok");
  assert.deepEqual(b.session, { leftPct: 43, tone: "ok" });
  assert.deepEqual(b.week, { leftPct: 59, tone: "ok" });
  assert.match(b.lines[0], /^Session: 43% left until /);
  assert.match(b.lines[1], /^Week: 59% left, resets /);
});

test("each ring is colored by its own level", () => {
  const b = badgeFor(view(claude, [snap("c", { usedPct: 97, resetsAt: NOW + HOUR }, { usedPct: 80, resetsAt: NOW + 50 * HOUR })]), null, NOW, NOW);
  assert.equal(b.session.tone, "empty");
  assert.equal(b.week.tone, "low");
});

test("a locked account empties both rings; an unused one has a full session ring", () => {
  const locked = badgeFor(view(ag, [snap("a", null, { usedPct: 100, resetsAt: NOW + 30 * HOUR })]), { state: "ok" }, NOW, NOW);
  assert.equal(locked.state, "locked");
  assert.deepEqual([locked.session.leftPct, locked.week.leftPct], [0, 0]);
  const ready = badgeFor(view(ag, [snap("a", null)]), { state: "ok" }, NOW, NOW);
  assert.deepEqual(ready.session, { leftPct: 100, tone: "ok" });
  // Antigravity reports no weekly percent unless it is locked.
  assert.deepEqual(ready.week, { leftPct: null, tone: "unknown" });
  assert.deepEqual(ready.lines, ["Session: ready, none running", "Week: not reported"]);
});

test("an account that cannot be read shows empty grey rings", () => {
  assert.equal(badgeFor(view(ag, []), null, null, NOW).state, "unknown");
  const signedOut = badgeFor(view(claude, [snap("c", { usedPct: 10, resetsAt: NOW + HOUR })]), { state: "signed-out" }, NOW, NOW);
  assert.deepEqual([signedOut.state, signedOut.lines], ["unknown", ["Signed out"]]);
});

test("initials make a short label for each account", () => {
  assert.equal(initials("Claude 1"), "C1");
  assert.equal(initials("Antigravity 12"), "A12");
  assert.equal(initials("work laptop"), "WL");
  assert.equal(initials("Work"), "WO");
  assert.equal(initials("  "), "?");
});
