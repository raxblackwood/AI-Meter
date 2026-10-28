// File-backed storage. Each file has exactly one writer:
//   claude-feed.jsonl        append-only, written by statusline.js
//   claude-latest.json       last feed record, written by statusline.js (dedupe + freshness)
//   manual-entries.json      written by server.js
//   antigravity-feed.jsonl   append-only, written by server.js (Antigravity collector)
//   antigravity-latest.json  last reading per email, written by server.js
//   account-links.json       email -> account id, written by server.js
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FEED_FILE = "claude-feed.jsonl";
const LATEST_FILE = "claude-latest.json";
const ENTRIES_FILE = "manual-entries.json";
const AG_FEED_FILE = "antigravity-feed.jsonl";
const AG_LATEST_FILE = "antigravity-latest.json";
const LINKS_FILE = "account-links.json";
// Rewrite claude-latest.json at most this often when nothing changed, to keep "last seen" fresh.
const LATEST_REFRESH_MS = 60_000;

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

/** Converts the status line's `rate_limits` object into a feed record, or null if it has no windows. */
export function feedRecord(rateLimits, at) {
  const win = (w) =>
    w && Number.isFinite(w.used_percentage) && Number.isFinite(w.resets_at)
      ? { usedPct: w.used_percentage, resetsAt: w.resets_at * 1000 }
      : null;
  const session = win(rateLimits?.five_hour);
  const weekly = win(rateLimits?.seven_day);
  if (!session && !weekly) return null;
  return { at, session, weekly };
}

function sameWindow(a, b) {
  if (!a || !b) return a === b;
  return a.usedPct === b.usedPct && a.resetsAt === b.resetsAt;
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

/** Appends a feed record when the limits changed since the last one. Returns true if appended. */
export function recordFeed(record, dir = dataDir()) {
  const latestPath = join(dir, LATEST_FILE);
  const latest = readJson(latestPath, null);
  const changed = !latest || !sameWindow(latest.session, record.session) || !sameWindow(latest.weekly, record.weekly);
  if (changed) {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, FEED_FILE), JSON.stringify(record) + "\n");
  }
  if (changed || record.at - (latest.seenAt ?? latest.at) >= LATEST_REFRESH_MS) {
    writeJsonAtomic(latestPath, { ...record, at: changed ? record.at : latest.at, seenAt: record.at });
  }
  return changed;
}

/** Claude snapshots from the status line feed, plus when the feed was last seen. */
export function readFeed(dir = dataDir()) {
  const snapshots = readJsonLines(join(dir, FEED_FILE)).map((r) => (
    { accountId: "claude", at: r.at, session: r.session, weekly: r.weekly, source: "statusline" }));
  const latest = readJson(join(dir, LATEST_FILE), null);
  return { snapshots, seenAt: latest?.seenAt ?? null };
}

export function readLinks(dir = dataDir()) {
  return readJson(join(dir, LINKS_FILE), {});
}

export function writeLinks(links, dir = dataDir()) {
  writeJsonAtomic(join(dir, LINKS_FILE), links);
}

/**
 * Links an Antigravity email to an account the first time it is seen, taking the first
 * candidate account that has no email yet. Returns the account id, or null if all are taken.
 */
export function linkEmail(email, candidateIds, dir = dataDir()) {
  const links = readLinks(dir);
  // A null link means the user unlinked this email on purpose; respect that.
  if (email in links) return links[email];
  const taken = new Set(Object.values(links));
  const free = candidateIds.find((id) => !taken.has(id));
  if (!free) return null;
  writeLinks({ ...links, [email]: free }, dir);
  return free;
}

/** Appends an Antigravity reading when its limits changed for that email. Returns true if appended. */
export function recordAntigravity(reading, dir = dataDir()) {
  const latestPath = join(dir, AG_LATEST_FILE);
  const latest = readJson(latestPath, {});
  const prev = latest[reading.email];
  const changed = !prev || !sameWindow(prev.session, reading.session)
    || !sameWindow(prev.weekly, reading.weekly) || !sameWindow(prev.flash, reading.flash);
  if (changed) {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, AG_FEED_FILE), JSON.stringify(reading) + "\n");
  }
  writeJsonAtomic(latestPath, { ...latest, [reading.email]: { ...reading, at: changed ? reading.at : prev.at, seenAt: reading.at } });
  return changed;
}

/**
 * Antigravity snapshots mapped to accounts through the email links, so relinking an email
 * moves its whole history. Readings for unlinked emails are left out.
 */
export function readAntigravityFeed(dir = dataDir()) {
  const links = readLinks(dir);
  const snapshots = readJsonLines(join(dir, AG_FEED_FILE))
    .filter((r) => links[r.email])
    .map((r) => ({ accountId: links[r.email], at: r.at, session: r.session, weekly: r.weekly, flash: r.flash ?? null, source: "antigravity" }));
  const latest = readJson(join(dir, AG_LATEST_FILE), {});
  const detected = Object.entries(latest)
    .map(([email, r]) => ({ email, accountId: links[email] ?? null, seenAt: r.seenAt, plan: r.plan ?? null }))
    .sort((a, b) => b.seenAt - a.seenAt);
  return { snapshots, detected };
}

export function readEntries(dir = dataDir()) {
  return readJson(join(dir, ENTRIES_FILE), []);
}

export function writeEntries(entries, dir = dataDir()) {
  writeJsonAtomic(join(dir, ENTRIES_FILE), entries);
}
