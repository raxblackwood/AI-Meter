// Generates the app, page and extension icons: six halos stacked into a column, the AI Meter mark.
// Each halo is a thin elliptical ring in the accent color; they fade in from top to bottom like a
// meter filling up. Run with `node scripts/make-icons.mjs` after changing the design.
import { writeFileSync } from "node:fs";
import { encodePng } from "../src/png.js";

const ACCENT = [99, 102, 241];
const HALOS = 6;
const SAMPLES = 4;

/** How far a point is inside an ellipse: below 1 inside, above 1 outside. */
const ellipse = (px, py, cx, cy, rx, ry) => ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2;

function png(size) {
  const rx = size * 0.4;
  const ry = size * 0.1;
  const stroke = Math.max(1, size * 0.05);
  const top = size * 0.17;
  const step = (size * 0.66) / (HALOS - 1);
  const halos = Array.from({ length: HALOS }, (_, i) => ({
    cy: top + i * step,
    // Faint at the top, full at the bottom.
    alpha: 0.4 + (0.6 * i) / (HALOS - 1),
  }));

  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let alpha = 0;
      for (let i = 0; i < SAMPLES; i++) {
        for (let j = 0; j < SAMPLES; j++) {
          const px = x + (i + 0.5) / SAMPLES;
          const py = y + (j + 0.5) / SAMPLES;
          let sample = 0;
          for (const h of halos) {
            // On the ring: inside the outer ellipse and outside the inner one.
            const inOuter = ellipse(px, py, size / 2, h.cy, rx, ry) <= 1;
            const inInner = ellipse(px, py, size / 2, h.cy, rx - stroke, ry - stroke) <= 1;
            if (inOuter && !inInner) sample = Math.max(sample, h.alpha);
          }
          alpha += sample;
        }
      }
      rgba.set([...ACCENT, Math.round((alpha / (SAMPLES * SAMPLES)) * 255)], (y * size + x) * 4);
    }
  }
  return encodePng(size, rgba);
}

writeFileSync(new URL("../app/icon.png", import.meta.url), png(256));
writeFileSync(new URL("../public/icon.png", import.meta.url), png(64));
writeFileSync(new URL("../extension/icon-32.png", import.meta.url), png(32));
writeFileSync(new URL("../extension/icon-128.png", import.meta.url), png(128));
console.log("icons written");
