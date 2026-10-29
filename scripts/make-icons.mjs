// Generates the app, tray, page and extension icons: three rising bars in the accent color.
// Run with `node scripts/make-icons.mjs` after changing the design.
import { writeFileSync } from "node:fs";
import { encodePng, roundedRectCoverage } from "../src/png.js";

const ACCENT = [99, 102, 241];

function png(size) {
  const u = size / 16;
  const bars = [
    { x: 1 * u, y: 9 * u, w: 3 * u, h: 6 * u, rad: u },
    { x: 6.5 * u, y: 5 * u, w: 3 * u, h: 10 * u, rad: u },
    { x: 12 * u, y: 1 * u, w: 3 * u, h: 14 * u, rad: u },
  ];
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = Math.min(1, bars.reduce((sum, b) => sum + roundedRectCoverage(x, y, b), 0));
      rgba.set([...ACCENT, Math.round(a * 255)], (y * size + x) * 4);
    }
  }
  return encodePng(size, rgba);
}

writeFileSync(new URL("../app/icon.png", import.meta.url), png(256));
writeFileSync(new URL("../app/tray.png", import.meta.url), png(32));
writeFileSync(new URL("../public/icon.png", import.meta.url), png(64));
writeFileSync(new URL("../extension/icon-32.png", import.meta.url), png(32));
writeFileSync(new URL("../extension/icon-128.png", import.meta.url), png(128));
console.log("icons written");
