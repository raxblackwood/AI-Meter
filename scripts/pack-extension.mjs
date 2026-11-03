// Packs extension/ into dist/ai-usage-connector-<version>.zip for the Chrome Web Store.
// Writes a plain zip (deflate) itself, so it needs no tools beyond Node.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { packZip } from "../src/zip.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE = join(ROOT, "extension");
const manifest = JSON.parse(readFileSync(join(SOURCE, "manifest.json"), "utf8"));
const OUT = join(ROOT, "dist", `ai-usage-connector-${manifest.version}.zip`);

mkdirSync(join(ROOT, "dist"), { recursive: true });
const buffer = packZip(SOURCE);
writeFileSync(OUT, buffer);
console.log(`${relative(ROOT, OUT)} (${buffer.length} bytes)`);
