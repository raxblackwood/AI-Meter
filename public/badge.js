// What the floating meter shows for one account: two levels, the 5-hour session (outer ring) and the
// week (inner ring). Pure, so the meter page and the tests share it.

const DAY = 24 * 60 * 60 * 1000;

function clock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** "14:20" today, "Tue 14:20" within the week, otherwise "3 Nov". */
function when(ms, now) {
  if (new Date(ms).toDateString() === new Date(now).toDateString()) return clock(ms);
  if (ms - now < 6 * DAY) return `${new Date(ms).toLocaleDateString([], { weekday: "short" })} ${clock(ms)}`;
  return new Date(ms).toLocaleDateString([], { day: "numeric", month: "short" });
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

/** How full a ring is and its color: null `leftPct` means the level is not known. */
function level(leftPct) {
  if (leftPct === null) return { leftPct: null, tone: "unknown" };
  const left = Math.max(0, Math.min(100, Math.round(leftPct)));
  return { leftPct: left, tone: left <= 5 ? "empty" : left <= 25 ? "low" : "ok" };
}

/**
 * The meter entry for an account: `session` and `week` levels (`leftPct`, `tone`), an overall `state`
 * (ok, locked, unknown), and lines for the hover card.
 * `view` comes from model.js accountView; `status` is the hub's status for the account.
 */
export function badgeFor(view, status, seen, now = Date.now()) {
  const name = view.account.name;
  if (!seen || status?.state === "signed-out" || status?.state === "error") {
    const why = !seen ? "Waiting for the first reading" : status.state === "signed-out" ? "Signed out" : "Could not be read";
    return { name, state: "unknown", session: level(null), week: level(null), lines: [why] };
  }
  if (view.exhausted) {
    return {
      name,
      state: "locked",
      session: level(0),
      week: level(0),
      lines: [`Locked until ${when(view.weekly.resetsAt, now)}`, "Weekly limit reached"],
    };
  }
  const open = view.session.state === "open";
  const session = level(open ? 100 - view.session.usedPct : 100);
  const week = level(view.weekly?.resetsAt ? 100 - view.weekly.usedPct : null);
  return {
    name,
    state: "ok",
    session,
    week,
    lines: [
      open ? `Session: ${session.leftPct}% left until ${when(view.session.resetsAt, now)}` : "Session: ready, none running",
      week.leftPct === null ? "Week: not reported" : `Week: ${week.leftPct}% left, resets ${when(view.weekly.resetsAt, now)}`,
    ],
  };
}
