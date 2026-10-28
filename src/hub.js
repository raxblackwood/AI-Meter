// Runs the collectors and keeps per-account status. Antigravity is read from the local language server;
// Claude readings arrive from the browser extension (extension/), which reads them with the browser's
// own claude.ai sign-in. Shared by the desktop app and the plain server.
import { createAntigravityCollector } from "./antigravity.js";
import { accountEmail, toReading as claudeReading } from "./claude.js";
import { accountForIdentity, readAccounts, recordReading } from "./store.js";

export function createHub({ antigravity = true, now = Date.now } = {}) {
  const status = {};
  // When the browser extension last reported, and its last error if the latest report was a failure.
  const connector = { claudeSeenAt: null, error: null };

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
    if (!email) throw Object.assign(new Error("Report has no account email"), { status: 400 });
    const reading = claudeReading(report.usage, now());
    if (!reading) throw Object.assign(new Error("Report has no usage limits"), { status: 400 });
    const account = accountForIdentity("claude", email);
    recordReading(account.id, reading);
    setStatus(account.id, "ok");
    connector.error = null;
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
