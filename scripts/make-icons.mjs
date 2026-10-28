// Generates the app, tray, page and extension icons: three rising bars in the accent color.
// Run with `node scripts/make-icons.mjs` after changing the design.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const ACCENT = [99, 102, 241];

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Coverage of pixel (x, y) by a rounded rectangle, with 4x4 supersampling for smooth edges. */
function coverage(x, y, r) {
  let hits = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const px = x + (i + 0.5) / 4;
      const py = y + (j + 0.5) / 4;
      if (px < r.x || px > r.x + r.w || py < r.y || py > r.y + r.h) continue;
      const cx = Math.min(Math.max(px, r.x + r.rad), r.x + r.w - r.rad);
      const cy = Math.min(Math.max(py, r.y + r.rad), r.y + r.h - r.rad);
      if ((px - cx) ** 2 + (py - cy) ** 2 <= r.rad ** 2) hits++;
    }
  }
  return hits / 16;
}

function png(size) {
  const u = size / 16;
  const bars = [
    { x: 1 * u, y: 9 * u, w: 3 * u, h: 6 * u, rad: u },
    { x: 6.5 * u, y: 5 * u, w: 3 * u, h: 10 * u, rad: u },
    { x: 12 * u, y: 1 * u, w: 3 * u, h: 14 * u, rad: u },
  ];
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const a = Math.min(1, bars.reduce((sum, b) => sum + coverage(x, y, b), 0));
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw.set([...ACCENT, Math.round(a * 255)], o);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

writeFileSync(new URL("../app/icon.png", import.meta.url), png(256));
writeFileSync(new URL("../app/tray.png", import.meta.url), png(32));
writeFileSync(new URL("../public/icon.png", import.meta.url), png(64));
writeFileSync(new URL("../extension/icon-32.png", import.meta.url), png(32));
writeFileSync(new URL("../extension/icon-128.png", import.meta.url), png(128));
console.log("icons written");
