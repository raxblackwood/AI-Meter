#!/usr/bin/env node
// Local-only HTTP server: serves the dashboard and a small JSON API over the data files.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCOUNT_IDS, ACCOUNTS } from "./public/accounts.js";
import { DAY } from "./public/model.js";
import { readEntries, readFeed, writeEntries } from "./src/store.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const MAX_BODY_BYTES = 16 * 1024;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
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
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}

function percent(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new HttpError(400, `${field} must be a number from 0 to 100`);
  }
  return value;
}

/** Validates a manual entry. `id` and `at` are accepted so an undo can restore a deleted entry unchanged. */
export function parseEntry(body, now) {
  if (!body || typeof body !== "object") throw new HttpError(400, "Body must be an object");
  if (!ACCOUNT_IDS.has(body.accountId)) throw new HttpError(400, "Unknown accountId");
  const at = body.at === undefined ? now : body.at;
  if (!Number.isFinite(at) || at > now + 60_000 || at < now - 30 * DAY) throw new HttpError(400, "Invalid at");
  const usedPct = percent(body.usedPct, "usedPct");
  const resetsAt = body.resetsAt;
  if (!Number.isFinite(resetsAt) || resetsAt <= at || resetsAt > at + 8 * DAY) {
    throw new HttpError(400, "resetsAt must be after the entry time and within 8 days");
  }
  const id = body.id === undefined ? randomUUID() : String(body.id);
  return { id, accountId: body.accountId, at, session: { usedPct, resetsAt }, weekly: null, source: "manual" };
}

async function handleApi(req, res, url) {
  const now = Date.now();
  if (req.method === "GET" && url.pathname === "/api/state") {
    const feed = readFeed();
    const entries = readEntries();
    return sendJson(res, 200, {
      now,
      accounts: ACCOUNTS,
      snapshots: [...feed.snapshots, ...entries],
      entries: [...entries].sort((a, b) => b.at - a.at),
      feedSeenAt: feed.seenAt,
    });
  }
  if (req.method === "POST" && url.pathname === "/api/entries") {
    const entry = parseEntry(await readBody(req), now);
    const entries = readEntries();
    if (entries.some((e) => e.id === entry.id)) throw new HttpError(409, "Entry already exists");
    writeEntries([...entries, entry]);
    return sendJson(res, 201, entry);
  }
  const match = url.pathname.match(/^\/api\/entries\/([\w-]+)$/);
  if (req.method === "DELETE" && match) {
    const entries = readEntries();
    const entry = entries.find((e) => e.id === match[1]);
    if (!entry) throw new HttpError(404, "No such entry");
    writeEntries(entries.filter((e) => e !== entry));
    return sendJson(res, 200, entry);
  }
  throw new HttpError(404, "Not found");
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

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
      else if (req.method === "GET") await serveStatic(res, url);
      else throw new HttpError(405, "Method not allowed");
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      sendJson(res, status, { error: status === 500 ? "Internal error" : err.message });
    }
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT) || 4317;
  createApp().listen(port, "127.0.0.1", () => {
    console.log(`AI Usage Dashboard on http://localhost:${port}`);
  });
}
