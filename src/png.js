// Minimal PNG writer for small RGBA images (app icons and taskbar badges). No dependencies.
import { deflateSync } from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encodes `rgba` (size*size*4 bytes, row by row) as a PNG. */
export function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Fraction of pixel (x, y) covered by a rounded rectangle, with 4x4 supersampling for smooth edges. */
export function roundedRectCoverage(x, y, r) {
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
