// Runs the collectors and keeps per-account status. Antigravity is read from the local language server;
// Claude readings arrive from the browser extension (extension/), which reads them with the browser's
// own claude.ai sign-in. Shared by the desktop app and the plain server.
import { createAntigravityCollector } from "./antigravity.js";
import { accountEmail, toReading as claudeReading } from "./claude.js";
import { accountForIdentity, readAccounts, recordReading } from "./store.js";

export function createHub({ antigravity = true, now = Date.now } = {}) {
  const status = {};
  // When the browser extension last reported, so the page can say whether it is connected.
  const connector = { claudeSeenAt: null };

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
   * `{ email, signedOut: true }` when that browser profile is no longer signed in.
   * Returns the account it was filed under.
   */
  function receiveClaude(report) {
    connector.claudeSeenAt = now();
    const email = accountEmail(report.account) ?? accountEmail({ email: report.email });
    if (!email) throw Object.assign(new Error("Report has no account email"), { status: 400 });
    if (report.signedOut) {
      const account = readAccounts().find((a) => a.provider === "claude" && a.email === email);
      if (account) setStatus(account.id, "signed-out", "Signed out of claude.ai in the browser");
      return account ?? null;
    }
    const reading = claudeReading(report.usage, now());
    if (!reading) throw Object.assign(new Error("Report has no usage limits"), { status: 400 });
    const account = accountForIdentity("claude", email);
    recordReading(account.id, reading);
    setStatus(account.id, "ok");
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
