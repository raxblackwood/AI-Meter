import assert from "node:assert/strict";
import { test } from "node:test";
import { badgeFor, initials } from "../public/badge.js";
import { accountView, HOUR } from "../public/model.js";

const NOW = Date.UTC(2026, 9, 29, 12, 0);
const claude = { id: "c", provider: "claude", name: "Claude 1" };
const ag = { id: "a", provider: "antigravity", name: "Antigravity 1" };
const view = (account, snaps) => accountView(account, snaps, NOW, NOW - 6 * HOUR, NOW + 3 * 24 * HOUR);
const snap = (accountId, session, weekly = null) => ({ accountId, at: NOW - 60_000, session, weekly, source: "auto" });

test("an open window shows the percent left, colored by how much is left", () => {
  const b = badgeFor(view(claude, [snap("c", { usedPct: 57, resetsAt: NOW + 2 * HOUR }, { usedPct: 41, resetsAt: NOW + 90 * HOUR })]), { state: "ok" }, NOW);
  assert.deepEqual([b.text, b.tone, b.fillPct, b.detail], ["43", "open", 43, "Week 41% used"]);
  assert.match(b.line, /^43% left until /);
  assert.equal(badgeFor(view(claude, [snap("c", { usedPct: 80, resetsAt: NOW + HOUR })]), null, NOW).tone, "low");
  assert.equal(badgeFor(view(claude, [snap("c", { usedPct: 97, resetsAt: NOW + HOUR })]), null, NOW).tone, "empty");
});

test("a locked account shows the lock, an unused one shows 100, an unread one shows ?", () => {
  const locked = badgeFor(view(ag, [snap("a", null, { usedPct: 100, resetsAt: NOW + 30 * HOUR })]), { state: "ok" }, NOW);
  assert.deepEqual([locked.glyph, locked.tone, locked.fillPct], ["lock", "empty", 0]);
  const ready = badgeFor(view(ag, [snap("a", null)]), { state: "ok" }, NOW);
  assert.deepEqual([ready.text, ready.tone, ready.fillPct], ["100", "ready", 100]);
  assert.equal(badgeFor(view(ag, []), null, null).text, "?");
  const signedOut = badgeFor(view(claude, [snap("c", { usedPct: 10, resetsAt: NOW + HOUR })]), { state: "signed-out" }, NOW);
  assert.deepEqual([signedOut.text, signedOut.line], ["?", "Signed out"]);
});

test("initials make a short label for each account", () => {
  assert.equal(initials("Claude 1"), "C1");
  assert.equal(initials("Antigravity 12"), "A12");
  assert.equal(initials("work laptop"), "WL");
  assert.equal(initials("Work"), "WO");
  assert.equal(initials("  "), "?");
});
