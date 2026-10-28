// Pure helpers for Claude readings. The browser extension (extension/background.js) reads the same
// endpoints claude.ai's Settings > Usage page uses, with the browser's own sign-in, and posts them here.
// These endpoints are not a public API, so parsing accepts the known shapes and fails soft.

/** Picks the personal subscription organization from GET /api/organizations. */
export function pickOrganization(orgs) {
  if (!Array.isArray(orgs) || !orgs.length) return null;
  const has = (org, cap) => Array.isArray(org.capabilities) && org.capabilities.includes(cap);
  return orgs.find((o) => has(o, "claude_max") || has(o, "claude_pro"))
    ?? orgs.find((o) => has(o, "chat"))
    ?? orgs[0];
}

function toWindow(value) {
  if (!value || typeof value !== "object") return null;
  const usedPct = Number(value.utilization ?? value.percent ?? value.used_percentage);
  const resetRaw = value.resets_at ?? value.resetsAt;
  const resetsAt = typeof resetRaw === "number" ? (resetRaw < 1e12 ? resetRaw * 1000 : resetRaw) : Date.parse(resetRaw ?? "");
  if (!Number.isFinite(usedPct) || !Number.isFinite(resetsAt)) return null;
  return { usedPct: Math.max(0, usedPct), resetsAt };
}

/**
 * Turns a usage response into a reading. Known shapes:
 *   { five_hour: { utilization, resets_at }, seven_day: { utilization, resets_at }, ... }
 *   { limits: [{ kind: "five_hour" | "seven_day", percent, resets_at }] }
 * A window without a reset time (nothing used yet) is recorded as no open window.
 */
export function toReading(usage, now) {
  if (!usage || typeof usage !== "object") return null;
  let fiveHour = usage.five_hour;
  let sevenDay = usage.seven_day;
  if (Array.isArray(usage.limits)) {
    fiveHour ??= usage.limits.find((l) => /five_hour|session/i.test(l.kind ?? ""));
    sevenDay ??= usage.limits.find((l) => /seven_day$|weekly/i.test(l.kind ?? ""));
  }
  if (fiveHour === undefined && sevenDay === undefined) return null;
  return { at: now, session: toWindow(fiveHour), weekly: toWindow(sevenDay) };
}

/** The signed-in email from GET /api/account, if the response has one. */
export function accountEmail(account) {
  const email = account?.email_address ?? account?.email ?? account?.account?.email_address;
  return typeof email === "string" && email.includes("@") ? email.toLowerCase() : null;
}
