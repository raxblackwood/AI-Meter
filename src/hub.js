// Runs the collectors and keeps per-account status. Shared by the desktop app and the plain server.
//   Antigravity: read from the local language server.
//   Claude, two ways, whichever the user picks per account:
//     - the browser extension (extension/) posts readings made with the browser's own claude.ai sign-in;
//     - the desktop app signs in itself (app/claude-client.js) and polls those accounts here.
import { randomUUID } from "node:crypto";
import { createAntigravityCollector } from "./antigravity.js";
import { accountEmail, toReading as claudeReading } from "./claude.js";
import { readCodexAuth } from "./codex.js";
import { accountForIdentity, createAccount, readAccounts, readReadings, readSeen, recordReading, updateAccount } from "./store.js";

const CLAUDE_POLL_MS = 3 * 60_000;

/** Field names and value types of an object, two levels deep, with no values. */
function shape(value, depth = 0) {
  if (Array.isArray(value)) return value.length && depth < 2 ? [shape(value[0], depth + 1)] : [];
  if (value && typeof value === "object") {
    if (depth >= 2) return "object";
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, depth + 1)]));
  }
  return value === null ? "null" : typeof value;
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * `claudeClient` is provided by the desktop app only:
 *   signIn(partition) -> Promise<{ email, orgId }>   opens a sign-in window; rejects with code "cancelled" if closed
 *   fetchUsage(account) -> Promise<object>          throws with code "signed-out" when the session ended
 */
export function createHub({ claudeClient = null, antigravity = true, now = Date.now } = {}) {
  const status = {};
  // When the browser extension last reported, and its last error if the latest report was a failure.
  const connector = { claudeSeenAt: null, error: null, rejectedShape: null };
  const signIn = { pending: false, error: null };
  const timers = [];

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

  // ---------- Claude through the browser extension ----------

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
      // An account the app also signs in to itself keeps its own status.
      if (account && !account.partition) setStatus(account.id, report.signedOut ? "signed-out" : "error", connector.error);
      return account || null;
    }
    const reject = (message) => {
      // Keep the field names (never the values) of what claude.ai returned, to see what changed.
      connector.error = message;
      connector.rejectedShape = { account: shape(report.account), usage: shape(report.usage) };
      return httpError(400, message);
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

  // ---------- Claude signed in inside the app ----------

  async function pollClaude(account) {
    try {
      const reading = claudeReading(await claudeClient.fetchUsage(account), now());
      if (!reading) throw new Error("claude.ai returned usage in an unknown format");
      recordReading(account.id, reading);
      setStatus(account.id, "ok");
    } catch (err) {
      setStatus(account.id, err.code === "signed-out" ? "signed-out" : "error", err.message);
    }
  }

  async function pollAppAccounts() {
    const accounts = readAccounts().filter((a) => a.provider === "claude" && a.partition && !a.removedAt);
    await Promise.all(accounts.map(pollClaude));
  }

  /**
   * Opens a sign-in window for a new account (no id) or to sign an existing one in again. Returns at once;
   * the page follows `signIn.pending`. When it finishes, the account is created or updated and read.
   */
  function startSignIn(accountId) {
    if (!claudeClient) throw httpError(501, "Signing in inside the app needs the desktop app");
    if (signIn.pending) throw httpError(409, "A sign-in window is already open");
    const existing = accountId ? readAccounts().find((a) => a.id === accountId) : null;
    if (accountId && !existing) throw httpError(404, "No such account");
    const partition = existing?.partition ?? `persist:claude-${randomUUID()}`;
    Object.assign(signIn, { pending: true, error: null });
    (async () => {
      try {
        const { email, orgId } = await claudeClient.signIn(partition);
        const sameEmail = email && readAccounts().find((a) => a.provider === "claude" && a.email === email);
        const target = existing ?? sameEmail;
        const account = target
          ? updateAccount(target.id, { email: email ?? target.email, orgId, partition, removedAt: null })
          : createAccount({ provider: "claude", email, orgId, partition });
        await pollClaude(account);
      } catch (err) {
        signIn.error = err.code === "cancelled" ? null : err.message;
      } finally {
        signIn.pending = false;
      }
    })();
  }

  function recordAccountReading(accountId, reading) {
    const account = readAccounts().find((a) => a.id === accountId);
    if (!account) throw httpError(404, "No such account");
    recordReading(accountId, reading);
    setStatus(accountId, "ok");
    return account;
  }

  function receiveCustomReading(payload) {
    const provider = payload.provider || "other";
    const email = payload.email || null;
    let account;
    if (email) {
      account = accountForIdentity(provider, email);
    } else if (payload.name) {
      account = readAccounts().find((a) => a.provider === provider && a.name === payload.name)
        ?? createAccount({ provider, name: payload.name, plan: payload.plan });
    } else {
      account = createAccount({ provider, plan: payload.plan });
    }
    const reading = {
      at: now(),
      session: payload.session ?? null,
      weekly: payload.weekly ?? null,
    };
    recordReading(account.id, reading);
    setStatus(account.id, "ok");
    return account;
  }

  const codexStatus = { available: false, email: null, plan: null };

  function pollCodex() {
    const info = readCodexAuth();
    if (info && info.email) {
      codexStatus.available = true;
      codexStatus.email = info.email;
      codexStatus.plan = info.plan;
      const account = accountForIdentity("codex", info.email);
      if (info.plan && account.plan !== info.plan) {
        updateAccount(account.id, { plan: info.plan });
      }
      const seen = readSeen();
      if (!seen[account.id]) {
        recordReading(account.id, {
          at: now(),
          session: { usedPct: 0, resetsAt: now() + 3 * 3600_000 },
          weekly: { usedPct: 0, resetsAt: now() + 7 * 86_400_000 },
        });
      }
      setStatus(account.id, "ok");
    } else {
      codexStatus.available = false;
    }
  }

  return {
    status,
    connector,
    signIn,
    canSignIn: Boolean(claudeClient),
    antigravity: agCollector.status,
    codex: codexStatus,
    receiveClaude,
    receiveCustomReading,
    recordAccountReading,
    startSignIn,
    pollAppAccounts,
    pollCodex,
    start() {
      if (antigravity) agCollector.start();
      pollCodex();
      if (claudeClient) {
        pollAppAccounts();
        const timer = setInterval(pollAppAccounts, CLAUDE_POLL_MS);
        timer.unref?.();
        timers.push(timer);
      }
    },
    stop() {
      agCollector.stop();
      timers.forEach(clearInterval);
    },
  };
}
