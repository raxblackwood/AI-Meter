// File-backed storage, written only by the process that runs the collectors (the desktop app or server.js):
//   accounts.json   the account list: { id, provider, name, email, createdAt, removedAt?, partition?, orgId? }
//   readings.jsonl  append-only, one line per change in an account's limits
//   latest.json     last reading per account and when it was last seen (dedupe and freshness)
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ACCOUNTS_FILE = "accounts.json";
const READINGS_FILE = "readings.jsonl";
const LATEST_FILE = "latest.json";

export const PROVIDERS = {
  claude: { label: "Claude", plan: "Claude subscription" },
  antigravity: { label: "Antigravity", plan: "Google AI Pro" },
  codex: { label: "Codex", plan: "OpenAI Codex / ChatGPT" },
  other: { label: "Custom", plan: "Custom AI plan" },
};

export function dataDir() {
  return process.env.AI_USAGE_DATA_DIR || join(ROOT, "data");
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

function readJsonLines(path) {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const records = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A torn final line from an interrupted append; skip it.
    }
  }
  return records;
}

// ---------- accounts ----------

export function readAccounts(dir = dataDir()) {
  migrateLegacy(dir);
  return readJson(join(dir, ACCOUNTS_FILE), []);
}

function writeAccounts(accounts, dir) {
  writeJsonAtomic(join(dir, ACCOUNTS_FILE), accounts);
}

/** Default name for a new account: "Claude 2", "Antigravity 3", "Codex 1", counting removed ones so names stay unique. */
function nextName(accounts, provider) {
  const meta = PROVIDERS[provider] || { label: provider.charAt(0).toUpperCase() + provider.slice(1) };
  const label = meta.label;
  const used = new Set(accounts.map((a) => a.name));
  for (let n = accounts.filter((a) => a.provider === provider).length + 1; ; n++) {
    if (!used.has(`${label} ${n}`)) return `${label} ${n}`;
  }
}

/**
 * `partition` and `orgId` are set only for Claude accounts signed in inside the desktop app:
 * the Electron session that holds the sign-in, and the organization to read usage for.
 */
export function createAccount({ provider, email = null, name = null, plan = null, partition = null, orgId = null, subType = null, renewsDay = null, endsAt = null }, dir = dataDir()) {
  const meta = PROVIDERS[provider] || { label: provider.charAt(0).toUpperCase() + provider.slice(1), plan: plan || "AI subscription" };
  const accounts = readAccounts(dir);
  const account = {
    id: randomUUID(),
    provider,
    name: name || nextName(accounts, provider),
    email,
    plan: plan || meta.plan,
    subType,
    renewsDay,
    endsAt,
    createdAt: Date.now(),
  };
  if (partition) Object.assign(account, { partition, orgId });
  writeAccounts([...accounts, account], dir);
  return account;
}

/** Applies `changes` to one account and returns the updated account, or null if it does not exist. */
export function updateAccount(id, changes, dir = dataDir()) {
  const accounts = readAccounts(dir);
  const index = accounts.findIndex((a) => a.id === id);
  if (index < 0) return null;
  const updated = { ...accounts[index], ...changes };
  accounts[index] = updated;
  writeAccounts(accounts, dir);
  return updated;
}

/**
 * The account a reading from `provider` with this identity belongs to, created if new.
 * A removed account stays removed (the user chose that) but keeps its history, so restoring it loses nothing.
 */
export function accountForIdentity(provider, email, dir = dataDir()) {
  const accounts = readAccounts(dir);
  return accounts.find((a) => a.provider === provider && a.email === email) ?? createAccount({ provider, email }, dir);
}

// ---------- readings ----------

function sameWindow(a, b) {
  if (!a || !b) return a === b;
  return a.usedPct === b.usedPct && a.resetsAt === b.resetsAt;
}

function sameCredits(a, b) {
  if (!a || !b) return a === b;
  return a.prompt === b.prompt && a.flow === b.flow;
}

/**
 * Stores a reading `{ at, session, weekly, flash?, credits?, thirdParty? }` for an account. Appends to the feed only when the
 * limits changed; always refreshes the last-seen time. Returns true if appended.
 */
export function recordReading(accountId, reading, dir = dataDir()) {
  const latestPath = join(dir, LATEST_FILE);
  const latest = readJson(latestPath, {});
  const prev = latest[accountId];
  const record = { accountId, at: reading.at, session: reading.session ?? null, weekly: reading.weekly ?? null };
  if ("flash" in reading) record.flash = reading.flash ?? null;
  if ("credits" in reading) record.credits = reading.credits ?? null;
  if ("thirdParty" in reading) record.thirdParty = reading.thirdParty ?? null;
  if ("models" in reading) record.models = reading.models ?? null;
  const changed = !prev || !sameWindow(prev.session, record.session)
    || !sameWindow(prev.weekly, record.weekly) || !sameWindow(prev.flash ?? null, record.flash ?? null)
    || !sameWindow(prev.thirdParty ?? null, record.thirdParty ?? null)
    || !sameCredits(prev.credits ?? null, record.credits ?? null);
  if (changed) {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, READINGS_FILE), JSON.stringify(record) + "\n");
  }
  writeJsonAtomic(latestPath, { ...latest, [accountId]: { ...record, at: changed ? record.at : prev.at, seenAt: reading.at } });
  return changed;
}

export function readReadings(dir = dataDir()) {
  return readJsonLines(join(dir, READINGS_FILE)).map((r) => ({ ...r, source: "auto" }));
}

/** Last-seen time per account id. */
export function readSeen(dir = dataDir()) {
  return Object.fromEntries(Object.entries(readJson(join(dir, LATEST_FILE), {})).map(([id, r]) => [id, r.seenAt]));
}

// ---------- migration ----------

/**
 * Converts data from the first version (fixed accounts, email links, separate feeds) into the account
 * list and the shared readings feed. Runs once: only when accounts.json does not exist yet.
 */
function migrateLegacy(dir) {
  if (existsSync(join(dir, ACCOUNTS_FILE))) return;
  const links = readJson(join(dir, "account-links.json"), null);
  if (!links) return;
  const legacyNames = { ag1: "Antigravity 1", ag2: "Antigravity 2", ag3: "Antigravity 3" };
  const accounts = [];
  const idByEmail = {};
  for (const [email, slot] of Object.entries(links)) {
    if (!slot) continue;
    const account = { id: randomUUID(), provider: "antigravity", name: legacyNames[slot] ?? email, email, createdAt: Date.now() };
    accounts.push(account);
    idByEmail[email] = account.id;
  }
  const lines = readJsonLines(join(dir, "antigravity-feed.jsonl"))
    .filter((r) => idByEmail[r.email])
    .map((r) => JSON.stringify({ accountId: idByEmail[r.email], at: r.at, session: r.session, weekly: r.weekly, flash: r.flash ?? null }));
  const legacyLatest = readJson(join(dir, "antigravity-latest.json"), {});
  const latest = {};
  for (const [email, r] of Object.entries(legacyLatest)) {
    const id = idByEmail[email];
    if (id) latest[id] = { accountId: id, at: r.at, session: r.session, weekly: r.weekly, flash: r.flash ?? null, seenAt: r.seenAt };
  }
  mkdirSync(dir, { recursive: true });
  if (lines.length) appendFileSync(join(dir, READINGS_FILE), lines.join("\n") + "\n");
  writeJsonAtomic(join(dir, LATEST_FILE), latest);
  writeAccounts(accounts, dir);
}
