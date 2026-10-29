import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { accountView, HOUR } from "../public/model.js";
import { badgeFor, renderBadge } from "../src/badges.js";

const NOW = Date.UTC(2026, 9, 29, 12, 0);
const claude = { id: "c", provider: "claude", name: "Claude 1" };
const ag = { id: "a", provider: "antigravity", name: "Antigravity 1" };
const view = (account, snaps) => accountView(account, snaps, NOW, NOW - 6 * HOUR, NOW + 3 * 24 * HOUR);
const snap = (accountId, session, weekly = null) => ({ accountId, at: NOW - 60_000, session, weekly, source: "auto" });

test("an open window shows the percent left, colored by how much is left", () => {
  const b = badgeFor(view(claude, [snap("c", { usedPct: 57, resetsAt: NOW + 2 * HOUR }, { usedPct: 41, resetsAt: NOW + 90 * HOUR })]), { state: "ok" }, NOW);
  assert.equal(b.text, "43");
  assert.equal(b.tone, "open");
  assert.match(b.tooltip, /^Claude 1: 43% left until .+, week 41% used$/);
  assert.equal(badgeFor(view(claude, [snap("c", { usedPct: 80, resetsAt: NOW + HOUR })]), null, NOW).tone, "low");
  assert.equal(badgeFor(view(claude, [snap("c", { usedPct: 97, resetsAt: NOW + HOUR })]), null, NOW).tone, "empty");
});

test("a locked account shows the lock, an unused one shows 100, an unread one shows ?", () => {
  const locked = badgeFor(view(ag, [snap("a", null, { usedPct: 100, resetsAt: NOW + 30 * HOUR })]), { state: "ok" }, NOW);
  assert.deepEqual([locked.glyph, locked.tone], ["lock", "empty"]);
  const ready = badgeFor(view(ag, [snap("a", null)]), { state: "ok" }, NOW);
  assert.deepEqual([ready.text, ready.tone], ["100", "ready"]);
  assert.deepEqual(badgeFor(view(ag, []), null, null).text, "?");
  const signedOut = badgeFor(view(claude, [snap("c", { usedPct: 10, resetsAt: NOW + HOUR })]), { state: "signed-out" }, NOW);
  assert.deepEqual([signedOut.text, signedOut.tooltip], ["?", "Claude 1: signed out"]);
});

/** Decodes the PNG writer's own output: one IDAT, filter 0 on every row. */
function pixels(png) {
  const size = png.readUInt32BE(16);
  const idat = png.indexOf("IDAT");
  const raw = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  const at = (x, y) => [...raw.subarray(y * (size * 4 + 1) + 1 + x * 4, y * (size * 4 + 1) + 1 + x * 4 + 4)];
  return { size, at };
}

test("badges render as square PNGs with the digits in the foreground color", () => {
  for (const size of [16, 32]) {
    const png = renderBadge({ text: "43", tone: "open" }, size);
    const { size: s, at } = pixels(png);
    assert.equal(s, size);
    // Corners are transparent (rounded tile); the middle row has white digit pixels on the accent tile.
    assert.equal(at(0, 0)[3], 0);
    const middle = Array.from({ length: size }, (_, x) => at(x, Math.floor(size / 2)));
    assert.ok(middle.some((p) => p[0] === 255 && p[1] === 255 && p[2] === 255 && p[3] === 255), "has digit pixels");
    assert.ok(middle.some((p) => p[0] === 79 && p[1] === 70 && p[2] === 229), "has tile pixels");
  }
  // Three digits and the lock also fit at the smallest size.
  assert.ok(renderBadge({ text: "100", tone: "ready" }, 16).length > 0);
  assert.ok(renderBadge({ glyph: "lock", tone: "empty" }, 16).length > 0);
});
