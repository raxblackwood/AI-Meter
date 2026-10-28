// Runs the collectors and keeps per-account status. Antigravity is read from the local language server;
// Claude readings arrive from the browser extension (extension/), which reads them with the browser's
// own claude.ai sign-in. Shared by the desktop app and the plain server.
import { createAntigravityCollector } from "./antigravity.js";
import { accountEmail, toReading as claudeReading } from "./claude.js";
import { accountForIdentity, readAccounts, recordReading } from "./store.js";

/** Field names and value types of an object, two levels deep, with no values. */
function shape(value, depth = 0) {
  if (Array.isArray(value)) return value.length && depth < 2 ? [shape(value[0], depth + 1)] : [];
  if (value && typeof value === "object") {
    if (depth >= 2) return "object";
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, depth + 1)]));
  }
  return value === null ? "null" : typeof value;
}

export function createHub({ antigravity = true, now = Date.now } = {}) {
  const status = {};
  // When the browser extension last reported, and its last error if the latest report was a failure.
  const connector = { claudeSeenAt: null, error: null, rejectedShape: null };

  const setStatus = (id, state, error = null) => {
    status[id] = { state, error, checkedAt: now() };
  };

  const agCollector = createAntigravityCollector({
    now,
    onReading(reading) {
      const account = accountForIdentity("antigravity", reading.email);
      recordReading(account.id, reading);
      setStatus(account.id, "ok");
    },
  });

  /**
   * Handles one report from the extension: `{ account, orgId, usage, email }` with a reading, or
   * `{ email?, signedOut, error }` when it could not read claude.ai (a signed-out profile, or a failure).
   * Returns the account it was filed under, if any.
   */
  function receiveClaude(report) {
    connector.claudeSeenAt = now();
    const email = accountEmail(report.account) ?? accountEmail({ email: report.email });
    if (report.error || report.signedOut) {
      connector.error = report.signedOut ? "Not signed in to claude.ai in that browser" : String(report.error).slice(0, 200);
      const account = email && readAccounts().find((a) => a.provider === "claude" && a.email === email);
      if (account) setStatus(account.id, report.signedOut ? "signed-out" : "error", connector.error);
      return account || null;
    }
    const reject = (message) => {
      // Keep the field names (never the values) of what claude.ai returned, to see what changed.
      connector.error = message;
      connector.rejectedShape = { account: shape(report.account), usage: shape(report.usage) };
      return Object.assign(new Error(message), { status: 400 });
    };
    if (!email) throw reject("The report had no account email");
    const reading = claudeReading(report.usage, now());
    if (!reading) throw reject("The report had no usage limits in a known format");
    const account = accountForIdentity("claude", email);
    recordReading(account.id, reading);
    setStatus(account.id, "ok");
    connector.error = null;
    connector.rejectedShape = null;
    return account;
  }

  return {
    status,
    connector,
    antigravity: agCollector.status,
    receiveClaude,
    start() {
      if (antigravity) agCollector.start();
    },
    stop() {
      agCollector.stop();
    },
  };
}
