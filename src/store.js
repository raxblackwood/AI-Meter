// File-backed storage. Each file has exactly one writer:
//   claude-feed.jsonl   append-only, written by statusline.js
//   claude-latest.json  last feed record, written by statusline.js (dedupe + freshness)
//   manual-entries.json written by server.js
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FEED_FILE = "claude-feed.jsonl";
const LATEST_FILE = "claude-latest.json";
const ENTRIES_FILE = "manual-entries.json";
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
  let text = "";
  try {
    text = readFileSync(join(dir, FEED_FILE), "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const snapshots = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      snapshots.push({ accountId: "claude", at: r.at, session: r.session, weekly: r.weekly, source: "statusline" });
    } catch {
      // A torn final line from a concurrent append; skip it.
    }
  }
  const latest = readJson(join(dir, LATEST_FILE), null);
  return { snapshots, seenAt: latest?.seenAt ?? null };
}

export function readEntries(dir = dataDir()) {
  return readJson(join(dir, ENTRIES_FILE), []);
}

export function writeEntries(entries, dir = dataDir()) {
  writeJsonAtomic(join(dir, ENTRIES_FILE), entries);
}
