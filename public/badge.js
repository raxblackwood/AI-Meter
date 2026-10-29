// What the floating meter shows for one account. Pure, so the meter page and the tests share it.

const pct = (n) => `${Math.round(n)}%`;

function clock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** "Claude 1" -> "C1", "Antigravity 2" -> "A2", "Work laptop" -> "WL", "Work" -> "WO". */
export function initials(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const last = words[words.length - 1];
  if (words.length > 1 && /^\d+$/.test(last)) return `${words[0][0]}${last}`.toUpperCase();
  if (words.length > 1) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  return words[0].slice(0, 2).toUpperCase();
}

/**
 * The meter entry for an account: `text` (percent or "?") or `glyph: "lock"`, a `tone`, how full the ring
 * is (`fillPct`, what is left), and two short lines for the hover card.
 * `view` comes from model.js accountView; `status` is the hub's status for the account.
 */
export function badgeFor(view, status, seen) {
  const name = view.account.name;
  const week = view.weekly?.resetsAt ? `Week ${pct(view.weekly.usedPct)} used` : null;
  if (!seen || status?.state === "signed-out" || status?.state === "error") {
    const why = !seen ? "Waiting for the first reading" : status.state === "signed-out" ? "Signed out" : "Could not be read";
    return { name, text: "?", tone: "unknown", fillPct: 0, line: why, detail: null };
  }
  if (view.exhausted) {
    return { name, glyph: "lock", tone: "empty", fillPct: 0, line: `Locked until ${clock(view.weekly.resetsAt)}`, detail: "Weekly limit reached" };
  }
  if (view.session.state !== "open") {
    return { name, text: "100", tone: "ready", fillPct: 100, line: "Ready, no window running", detail: week };
  }
  const left = Math.max(0, Math.round(100 - view.session.usedPct));
  const tone = left <= 5 ? "empty" : left <= 25 ? "low" : "open";
  return { name, text: String(left), tone, fillPct: left, line: `${left}% left until ${clock(view.session.resetsAt)}`, detail: week };
}
