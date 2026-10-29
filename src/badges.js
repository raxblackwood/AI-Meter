// Taskbar badges: one small tray icon per account showing what is left in its current window.
// Pure functions; the desktop app turns the PNGs into tray icons.
import { encodePng, roundedRectCoverage } from "./png.js";

const TONES = {
  open: { bg: [79, 70, 229], fg: [255, 255, 255] }, // accent: window in use
  ready: { bg: [5, 150, 105], fg: [255, 255, 255] }, // green: full, no window running
  low: { bg: [245, 158, 11], fg: [28, 25, 23] }, // amber: 25% or less left
  empty: { bg: [220, 38, 38], fg: [255, 255, 255] }, // red: 5% or less, or locked
  unknown: { bg: [82, 82, 91], fg: [255, 255, 255] }, // grey: no reading, signed out, unreadable
};

// Pixel glyphs, crisp at tray sizes: digits are 3x5, the padlock 5x7.
const GLYPHS = {
  0: ["###", "#.#", "#.#", "#.#", "###"],
  1: [".#.", "##.", ".#.", ".#.", "###"],
  2: ["###", "..#", "###", "#..", "###"],
  3: ["###", "..#", "###", "..#", "###"],
  4: ["#.#", "#.#", "###", "..#", "..#"],
  5: ["###", "#..", "###", "..#", "###"],
  6: ["###", "#..", "###", "#.#", "###"],
  7: ["###", "..#", ".#.", ".#.", ".#."],
  8: ["###", "#.#", "###", "#.#", "###"],
  9: ["###", "#.#", "###", "..#", "###"],
  "?": ["###", "..#", ".##", "...", ".#."],
  lock: [".###.", "#...#", "#...#", "#####", "##.##", "##.##", "#####"],
};

const pct = (n) => `${Math.round(n)}%`;

function clock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * What an account's badge shows: `text` (digits or "?"), or the `lock` glyph, a tone, and a tooltip.
 * `view` comes from public/model.js accountView; `status` is the hub's status for the account.
 */
export function badgeFor(view, status, seen) {
  const name = view.account.name;
  if (!seen || status?.state === "signed-out" || status?.state === "error") {
    const why = !seen ? "waiting for the first reading" : status.state === "signed-out" ? "signed out" : "could not be read";
    return { text: "?", tone: "unknown", tooltip: `${name}: ${why}` };
  }
  if (view.exhausted) {
    return { glyph: "lock", tone: "empty", tooltip: `${name}: weekly limit hit, unlocks ${clock(view.weekly.resetsAt)}` };
  }
  const week = view.weekly?.resetsAt ? `, week ${pct(view.weekly.usedPct)} used` : "";
  if (view.session.state !== "open") {
    return { text: "100", tone: "ready", tooltip: `${name}: ready, no window running${week}` };
  }
  const left = Math.max(0, Math.round(100 - view.session.usedPct));
  const tone = left <= 5 ? "empty" : left <= 25 ? "low" : "open";
  return { text: String(left), tone, tooltip: `${name}: ${left}% left until ${clock(view.session.resetsAt)}${week}` };
}

/** Draws a badge as a square PNG of `size` pixels: a rounded tile with the number or lock, as large as fits. */
export function renderBadge(badge, size) {
  const { bg, fg } = TONES[badge.tone] ?? TONES.unknown;
  const glyphs = badge.glyph ? [GLYPHS[badge.glyph]] : [...badge.text].map((c) => GLYPHS[c] ?? GLYPHS["?"]);
  const textWidth = glyphs.reduce((w, g) => w + g[0].length, 0) + (glyphs.length - 1);
  const textHeight = Math.max(...glyphs.map((g) => g.length));
  const pad = Math.max(1, Math.round(size / 10));
  // Whole-pixel scaling keeps the glyphs sharp.
  const scale = Math.max(1, Math.min(Math.floor((size - 2 * pad) / textWidth), Math.floor((size - 2 * pad) / textHeight)));
  const left = Math.floor((size - textWidth * scale) / 2);
  const top = Math.floor((size - textHeight * scale) / 2);

  const ink = new Uint8Array(size * size);
  let cursor = left;
  for (const g of glyphs) {
    for (let row = 0; row < g.length; row++) {
      for (let col = 0; col < g[row].length; col++) {
        if (g[row][col] !== "#") continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) ink[(top + row * scale + dy) * size + cursor + col * scale + dx] = 1;
        }
      }
    }
    cursor += (g[0].length + 1) * scale;
  }

  const tile = { x: 0, y: 0, w: size, h: size, rad: size / 4 };
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const coverage = roundedRectCoverage(x, y, tile);
      const color = ink[y * size + x] ? fg : bg;
      rgba.set([...color, Math.round(coverage * 255)], (y * size + x) * 4);
    }
  }
  return encodePng(size, rgba);
}
