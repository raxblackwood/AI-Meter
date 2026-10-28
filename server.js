#!/usr/bin/env node
// Local-only HTTP server: serves the dashboard and a small JSON API over the data files, and receives
// Claude readings from the browser extension. The desktop app (app/main.js) runs it; `npm start` runs it
// without the tray.
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHub } from "./src/hub.js";
import { PROVIDERS, readAccounts, readReadings, readSeen, updateAccount } from "./src/store.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const EXTENSION_DIR = join(ROOT, "extension");
const CONNECTOR_PATH = "/api/connector/claude";
// Set in package.json once the extension is published, so Add account can offer a one-click install.
const STORE_URL = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).config?.chromeWebStoreUrl || null;
// Extension reports carry the claude.ai account and usage objects, which are a few kilobytes.
const MAX_BODY_BYTES = 256 * 1024;
const MAX_NAME_LENGTH = 40;
export const DEFAULT_PORT = 4317;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}

/**
 * Only this machine's own pages may use the API. The Host check stops DNS rebinding; the Origin check
 * stops other websites from sending requests that change data. Browser extensions may only post readings.
 */
export function checkLocal(req, port, pathname) {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowed.has(req.headers.host)) throw new HttpError(403, "Forbidden host");
  const origin = req.headers.origin;
  if (req.method === "GET" || !origin) return;
  if (allowed.has(origin.replace(/^http:\/\//, ""))) return;
  if (pathname === CONNECTOR_PATH && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return;
  throw new HttpError(403, "Forbidden origin");
}

function findAccount(id) {
  const account = readAccounts().find((a) => a.id === id);
  if (!account) throw new HttpError(404, "No such account");
  return account;
}

async function handleApi(req, res, url, hub) {
  if (req.method === "GET" && url.pathname === "/api/state") {
    const accounts = readAccounts();
    return sendJson(res, 200, {
      now: Date.now(),
      providers: PROVIDERS,
      accounts: accounts.filter((a) => !a.removedAt),
      removed: accounts.filter((a) => a.removedAt),
      snapshots: readReadings(),
      seen: readSeen(),
      status: hub.status,
      antigravity: hub.antigravity,
      connector: { ...hub.connector, extensionDir: EXTENSION_DIR, storeUrl: STORE_URL },
    });
  }
  if (req.method === "POST" && url.pathname === CONNECTOR_PATH) {
    const account = hub.receiveClaude(await readBody(req));
    return sendJson(res, 200, { accountId: account?.id ?? null });
  }
  const match = url.pathname.match(/^\/api\/accounts\/([\w-]+)(\/restore)?$/);
  if (!match) throw new HttpError(404, "Not found");
  const [, id, action] = match;
  findAccount(id);
  if (req.method === "POST" && action === "/restore") {
    return sendJson(res, 200, (updateAccount(id, { removedAt: null })));
  }
  if (req.method === "PATCH" && !action) {
    const body = await readBody(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > MAX_NAME_LENGTH) throw new HttpError(400, `Name must be 1 to ${MAX_NAME_LENGTH} characters`);
    return sendJson(res, 200, (updateAccount(id, { name })));
  }
  if (req.method === "DELETE" && !action) {
    // Soft remove, so Undo can bring it back with its history.
    return sendJson(res, 200, (updateAccount(id, { removedAt: Date.now() })));
  }
  throw new HttpError(405, "Method not allowed");
}

async function serveStatic(res, url) {
  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const path = normalize(join(PUBLIC_DIR, rel));
  if (!path.startsWith(PUBLIC_DIR + sep)) throw new HttpError(404, "Not found");
  let body;
  try {
    body = await readFile(path);
  } catch {
    throw new HttpError(404, "Not found");
  }
  res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream", "cache-control": "no-cache" });
  res.end(body);
}

export function createApp({ hub, port }) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      checkLocal(req, port, url.pathname);
      if (url.pathname.startsWith("/api/")) await handleApi(req, res, url, hub);
      else if (req.method === "GET") await serveStatic(res, url);
      else throw new HttpError(405, "Method not allowed");
    } catch (err) {
      const status = err.status ?? 500;
      if (status === 500) console.error(err);
      sendJson(res, status, { error: status === 500 ? "Internal error" : err.message });
    }
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const hub = createHub({ antigravity: process.env.AI_USAGE_ANTIGRAVITY !== "off" });
  hub.start();
  createApp({ hub, port }).listen(port, "127.0.0.1", () => {
    console.log(`AI Usage Dashboard on http://localhost:${port}`);
  });
}
