#!/usr/bin/env node
// Local-only HTTP server: serves the dashboard and a small JSON API over the data files, and receives
// Claude readings from the browser extension. The desktop app (app/main.js) runs it; `npm start` runs it
// without the tray.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHub } from "./src/hub.js";
import { createAccount, PROVIDERS, readAccounts, readReadings, readSeen, updateAccount } from "./src/store.js";
import { packZip } from "./src/zip.js";

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

/**
 * Accounts as the page sees them: whether the app signs in to it itself, but not the Electron session name.
 */
const publicAccount = ({ partition, orgId, ...rest }) => ({ ...rest, signedInHere: Boolean(partition) });

function findAccount(id) {
  const account = readAccounts().find((a) => a.id === id);
  if (!account) throw new HttpError(404, "No such account");
  return account;
}

/**
 * `meter` is the desktop app's floating meter (`isVisible()`, `setVisible(bool)`), or null when the server
 * runs on its own.
 */
async function handleApi(req, res, url, hub, meter) {
  if (req.method === "GET" && url.pathname === "/api/state") {
    const accounts = readAccounts();
    return sendJson(res, 200, {
      now: Date.now(),
      providers: PROVIDERS,
      accounts: accounts.filter((a) => !a.removedAt).map(publicAccount),
      removed: accounts.filter((a) => a.removedAt).map(publicAccount),
      snapshots: readReadings(),
      seen: readSeen(),
      status: hub.status,
      antigravity: hub.antigravity,
      codex: hub.codex,
      connector: { ...hub.connector, extensionDir: EXTENSION_DIR, storeUrl: STORE_URL },
      signIn: { available: hub.canSignIn, ...hub.signIn },
      meter: meter ? { visible: meter.isVisible() } : null,
    });
  }
  if (req.method === "POST" && url.pathname === "/api/meter") {
    if (!meter) throw new HttpError(501, "The floating meter is part of the desktop app");
    const body = await readBody(req);
    if (typeof body.visible !== "boolean") throw new HttpError(400, "visible must be true or false");
    meter.setVisible(body.visible);
    return sendJson(res, 200, { visible: meter.isVisible() });
  }
  if (req.method === "GET" && url.pathname === "/api/extension/download") {
    const zip = packZip(EXTENSION_DIR);
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="ai-meter-extension.zip"',
      "content-length": zip.length,
      "cache-control": "no-cache",
    });
    return res.end(zip);
  }
  if (req.method === "POST" && url.pathname === "/api/extension/open-folder") {
    const cmd = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    execFile(cmd, [EXTENSION_DIR], () => {});
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/accounts/claude/sign-in") {
    hub.startSignIn(null);
    return sendJson(res, 202, { started: true });
  }
  if (req.method === "POST" && url.pathname === "/api/accounts") {
    const body = await readBody(req);
    const provider = typeof body.provider === "string" && body.provider.trim() ? body.provider.trim() : "other";
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, MAX_NAME_LENGTH) : null;
    const email = typeof body.email === "string" && body.email.trim() ? body.email.trim() : null;
    const plan = typeof body.plan === "string" && body.plan.trim() ? body.plan.trim() : null;
    const subType = typeof body.subType === "string" ? body.subType : null;
    const renewsDay = body.renewsDay !== undefined ? Number(body.renewsDay) : null;
    const endsAt = body.endsAt !== undefined ? Number(body.endsAt) : null;
    const account = createAccount({ provider, name, email, plan, subType, renewsDay, endsAt });
    hub.status[account.id] = { state: "ok", error: null, checkedAt: Date.now() };

    const sessionLeft = body.sessionLeftPct !== undefined ? Number(body.sessionLeftPct) : (body.sessionUsedPct !== undefined ? 100 - Number(body.sessionUsedPct) : null);
    if (sessionLeft !== null || body.weeklyUsedPct !== undefined) {
      const nowMs = Date.now();
      const durationHours = Number(body.sessionDurationHours) || (provider === "codex" ? 3 : 5);
      const usedPct = sessionLeft !== null ? Math.max(0, Math.min(100, 100 - sessionLeft)) : 0;
      const resetsAt = nowMs + durationHours * 3600_000;
      const session = { usedPct, resetsAt };
      const weekly = body.weeklyUsedPct !== undefined
        ? { usedPct: Math.max(0, Math.min(100, Number(body.weeklyUsedPct))), resetsAt: nowMs + 7 * 86400_000 }
        : { usedPct: 0, resetsAt: nowMs + 7 * 86400_000 };
      hub.recordAccountReading(account.id, { at: nowMs, session, weekly });
    }

    return sendJson(res, 201, publicAccount(account));
  }
  if (req.method === "POST" && (url.pathname === "/api/connector/custom" || url.pathname === "/api/connector/reading")) {
    const account = hub.receiveCustomReading(await readBody(req));
    return sendJson(res, 200, { accountId: account?.id ?? null });
  }
  if (req.method === "POST" && url.pathname === CONNECTOR_PATH) {
    const account = hub.receiveClaude(await readBody(req));
    return sendJson(res, 200, { accountId: account?.id ?? null });
  }
  const match = url.pathname.match(/^\/api\/accounts\/([\w-]+)(\/restore|\/sign-in|\/reading)?$/);
  if (!match) throw new HttpError(404, "Not found");
  const [, id, action] = match;
  const account = findAccount(id);
  if (req.method === "POST" && action === "/sign-in") {
    if (account.provider !== "claude") throw new HttpError(400, "Only Claude accounts sign in here");
    hub.startSignIn(id);
    return sendJson(res, 202, { started: true });
  }
  if (req.method === "POST" && action === "/restore") {
    return sendJson(res, 200, publicAccount(updateAccount(id, { removedAt: null })));
  }
  if (req.method === "POST" && action === "/reading") {
    const body = await readBody(req);
    const nowMs = Date.now();
    let session = null;
    if (body.session) {
      session = body.session;
    } else if (body.sessionLeftPct !== undefined || body.sessionUsedPct !== undefined) {
      const left = body.sessionLeftPct !== undefined ? Number(body.sessionLeftPct) : 100 - Number(body.sessionUsedPct);
      const usedPct = Math.max(0, Math.min(100, 100 - left));
      const durationHours = Number(body.sessionDurationHours) || (account.provider === "codex" ? 3 : 5);
      const resetsAt = body.resetsAt ? Number(body.resetsAt) : nowMs + durationHours * 3600_000;
      session = { usedPct, resetsAt };
    }
    let weekly = null;
    if (body.weekly) {
      weekly = body.weekly;
    } else if (body.weeklyUsedPct !== undefined) {
      const usedPct = Math.max(0, Math.min(100, Number(body.weeklyUsedPct)));
      const resetsAt = body.weeklyResetsAt ? Number(body.weeklyResetsAt) : nowMs + 7 * 86400_000;
      weekly = { usedPct, resetsAt };
    }
    hub.recordAccountReading(id, { at: nowMs, session, weekly });

    const subUpdates = {};
    if (body.subType !== undefined) subUpdates.subType = body.subType;
    if (body.renewsDay !== undefined) subUpdates.renewsDay = body.renewsDay ? Number(body.renewsDay) : null;
    if (body.endsAt !== undefined) subUpdates.endsAt = body.endsAt ? Number(body.endsAt) : null;
    if (body.plan !== undefined) subUpdates.plan = body.plan ? String(body.plan).slice(0, 50) : null;
    if (Object.keys(subUpdates).length > 0) {
      updateAccount(id, subUpdates);
    }

    return sendJson(res, 200, { success: true, accountId: id });
  }
  if (req.method === "PATCH" && !action) {
    const body = await readBody(req);
    const updates = {};
    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name || name.length > MAX_NAME_LENGTH) throw new HttpError(400, `Name must be 1 to ${MAX_NAME_LENGTH} characters`);
      updates.name = name;
    }
    if (body.subType !== undefined) updates.subType = body.subType;
    if (body.renewsDay !== undefined) updates.renewsDay = body.renewsDay ? Number(body.renewsDay) : null;
    if (body.endsAt !== undefined) updates.endsAt = body.endsAt ? Number(body.endsAt) : null;
    if (body.plan !== undefined) updates.plan = body.plan ? String(body.plan).slice(0, 50) : null;
    return sendJson(res, 200, publicAccount(updateAccount(id, updates)));
  }
  if (req.method === "DELETE" && !action) {
    // Soft remove, so Undo can bring it back with its history.
    return sendJson(res, 200, publicAccount(updateAccount(id, { removedAt: Date.now() })));
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

export function createApp({ hub, port, meter = null }) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      checkLocal(req, port, url.pathname);
      if (url.pathname.startsWith("/api/")) await handleApi(req, res, url, hub, meter);
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
    console.log(`AI Meter on http://localhost:${port}`);
  });
}
