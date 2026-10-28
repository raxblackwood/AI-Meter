#!/usr/bin/env node
// Claude Code status line command. Claude Code pipes session JSON on stdin; when the account is a
// subscriber it includes `rate_limits.five_hour` and `rate_limits.seven_day`. This records them for
// the dashboard and prints a one-line status. It must never fail, or the status line goes blank.
import { feedRecord, recordFeed } from "./src/store.js";

function clock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function render(input, record) {
  const parts = [];
  if (input?.model?.display_name) parts.push(input.model.display_name);
  if (record?.session) parts.push(`5h ${Math.round(record.session.usedPct)}% (resets ${clock(record.session.resetsAt)})`);
  if (record?.weekly) parts.push(`week ${Math.round(record.weekly.usedPct)}%`);
  return parts.join(" · ");
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let input = null;
  let record = null;
  try {
    input = JSON.parse(raw);
    record = feedRecord(input.rate_limits, Date.now());
    if (record) recordFeed(record);
  } catch (err) {
    process.stderr.write(`ai-usage-dashboard statusline: ${err.message}\n`);
  }
  process.stdout.write(render(input, record));
});
