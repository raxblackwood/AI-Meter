// Reads Antigravity quota from its local language server, the same source the IDE quota page uses.
// The server is started by Antigravity with a `--csrf_token` argument and answers `GetUserStatus`
// on one of the localhost ports it listens on. `--https_server_port` is often 0 (picked at random),
// so the listening ports are looked up from the OS. This is not a public API, so every step fails soft.
// The CSRF token is only held in memory; it is never logged or written to disk.
import { execFile } from "node:child_process";
import http from "node:http";
import https from "node:https";

const STATUS_PATH = "/exa.language_server_pb.LanguageServerService/GetUserStatus";
const QUOTA_SUMMARY_PATH = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const STATUS_BODY = JSON.stringify({ metadata: { ideName: "antigravity", extensionName: "antigravity", locale: "en" } });
const REQUEST_TIMEOUT_MS = 4000;
const SESSION_MS = 5 * 60 * 60 * 1000;
// A reset further away than one session plus this slack is a weekly lockout, not a 5-hour window.
const SESSION_SLACK_MS = 15 * 60 * 1000;

/**
 * Extracts the connection details from a language server command line, or null if it is not Antigravity's.
 * `port` is null when the server picks its own port.
 */
export function parseCommandLine(commandLine) {
  if (!commandLine || !/antigravity/i.test(commandLine)) return null;
  const arg = (name) => commandLine.match(new RegExp(`--${name}[= ]("?)([^\\s"]+)\\1`))?.[2] ?? null;
  const csrfToken = arg("csrf_token");
  if (!csrfToken) return null;
  const port = Number(arg("https_server_port"));
  return { csrfToken, port: Number.isInteger(port) && port > 0 ? port : null };
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout));
  });
}

// One PowerShell call returns every language server with the loopback ports it listens on.
const WINDOWS_DISCOVERY = `
$servers = @(Get-CimInstance Win32_Process -Filter "Name LIKE 'language_server%'" | ForEach-Object {
  $ports = @(Get-NetTCPConnection -OwningProcess $_.ProcessId -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -in '127.0.0.1', '::1' } | Select-Object -ExpandProperty LocalPort | Sort-Object -Unique)
  [pscustomobject]@{ pid = $_.ProcessId; commandLine = $_.CommandLine; ports = $ports }
})
ConvertTo-Json -InputObject $servers -Compress -Depth 3`;

async function listProcesses() {
  if (process.platform === "win32") {
    const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_DISCOVERY]);
    return JSON.parse(out.trim() || "[]");
  }
  const lines = (await run("ps", ["-axo", "pid=,args="])).split("\n").filter((l) => /language_server/.test(l));
  return Promise.all(lines.map(async (line) => {
    const [, pid, commandLine] = line.trim().match(/^(\d+)\s+(.*)$/) ?? [];
    let ports = [];
    try {
      const out = await run("lsof", ["-Pan", "-p", pid, "-iTCP", "-sTCP:LISTEN"]);
      ports = [...out.matchAll(/(?:127\.0\.0\.1|\[::1\]|localhost):(\d+)/g)].map((m) => Number(m[1]));
    } catch {
      // lsof missing or no permission: fall back to the port in the arguments, if any.
    }
    return { pid: Number(pid), commandLine, ports };
  }));
}

/** Finds running Antigravity language servers. Returns [] when Antigravity is not running. */
export async function findLanguageServers() {
  const servers = [];
  for (const proc of await listProcesses()) {
    const parsed = parseCommandLine(proc.commandLine);
    if (!parsed) continue;
    const ports = [...new Set([parsed.port, ...(proc.ports ?? [])].filter((p) => Number.isInteger(p) && p > 0))];
    if (ports.length) servers.push({ pid: proc.pid, csrfToken: parsed.csrfToken, ports });
  }
  return servers;
}

function post(lib, port, path, body, csrfToken) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === "string" ? body : JSON.stringify(body ?? {});
    const req = lib.request({
      host: "127.0.0.1",
      port,
      path,
      method: "POST",
      // The language server uses a self-signed certificate on loopback.
      rejectUnauthorized: false,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        "content-type": "application/json",
        "connect-protocol-version": "1",
        "x-codeium-csrf-token": csrfToken,
        "content-length": Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`${path} returned ${res.statusCode}`));
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new Error(`${path} returned invalid JSON`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`${path} timed out`)));
    req.on("error", reject);
    req.end(payload);
  });
}

/**
 * Calls GetUserStatus and RetrieveUserQuotaSummary. The server listens on several ports with different protocols, so each port is
 * tried over HTTPS and then plain HTTP. The endpoint that answers is remembered on `server` and tried first.
 */
export async function fetchUserStatus(server) {
  const candidates = server.ports.flatMap((port) => [{ scheme: "https", port }, { scheme: "http", port }]);
  if (server.endpoint) candidates.unshift(server.endpoint);
  let firstError = null;
  for (const endpoint of candidates) {
    try {
      const lib = endpoint.scheme === "https" ? https : http;
      const result = await post(lib, endpoint.port, STATUS_PATH, STATUS_BODY, server.csrfToken);
      server.endpoint = endpoint;
      try {
        const quotaSummary = await post(lib, endpoint.port, QUOTA_SUMMARY_PATH, "{}", server.csrfToken);
        result.quotaSummary = quotaSummary?.response ?? quotaSummary;
      } catch {
        // Soft fail if RetrieveUserQuotaSummary is not supported on older language servers
      }
      return result;
    } catch (err) {
      firstError ??= err;
    }
  }
  throw firstError ?? new Error("No ports to try");
}

function classify(bucket, now) {
  if (!bucket) return { session: null, weekly: null };
  const usedPct = Math.round((1 - bucket.remaining) * 1000) / 10;
  // A full quota means no window is running yet.
  if (usedPct <= 0) return { session: null, weekly: null };
  const window = { usedPct, resetsAt: bucket.resetsAt };
  return bucket.resetsAt - now <= SESSION_MS + SESSION_SLACK_MS ? { session: window, weekly: null } : { session: null, weekly: window };
}

/**
 * Turns a GetUserStatus response into a reading for the signed-in account.
 * Models that share a quota report the same reset time. Flash models form their own bucket;
 * everything else is the premium bucket, which drives the main bar. Within a bucket the most
 * constrained model wins. Protobuf JSON omits zero values, so a missing remainingFraction means 0.
 */
export function toReading(status, now) {
  const user = status?.userStatus;
  if (!user?.email) return null;

  // Extract prompt and flow credits if reported by Antigravity planStatus
  const planStatus = user.planStatus;
  const promptCredits = planStatus?.availablePromptCredits;
  const flowCredits = planStatus?.availableFlowCredits;
  const credits = (Number.isFinite(promptCredits) || Number.isFinite(flowCredits))
    ? {
        prompt: Number.isFinite(promptCredits) ? promptCredits : null,
        flow: Number.isFinite(flowCredits) ? flowCredits : null,
      }
    : null;

  // If authoritative QuotaSummary is available from RetrieveUserQuotaSummary, use it directly
  if (status?.quotaSummary?.groups) {
    let geminiWeekly = null;
    let gemini5h = null;
    let thirdPartyWeekly = null;
    let thirdParty5h = null;

    for (const group of status.quotaSummary.groups) {
      const isGemini = /gemini/i.test(group.displayName ?? "");
      for (const bucket of group.buckets ?? []) {
        const isWeekly = bucket.window === "weekly" || /weekly/i.test(bucket.bucketId ?? "") || /weekly/i.test(bucket.displayName ?? "");
        const resetsAt = Date.parse(bucket.resetTime ?? "");
        const remaining = Math.min(1, Math.max(0, bucket.remainingFraction ?? 0));
        const usedPct = Math.round((1 - remaining) * 1000) / 10;
        const info = { usedPct, remainingPct: Math.round(remaining * 1000) / 10, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null };

        if (isGemini) {
          if (isWeekly) geminiWeekly = info;
          else gemini5h = info;
        } else {
          if (isWeekly) thirdPartyWeekly = info;
          else thirdParty5h = info;
        }
      }
    }

    const weekly = geminiWeekly?.resetsAt ? { usedPct: geminiWeekly.usedPct, resetsAt: geminiWeekly.resetsAt } : null;

    // Active session: Gemini 5h is primary. If Gemini 5h is completely unused (usedPct <= 0),
    // but thirdParty 5h is active, fall back to thirdParty 5h.
    let session = null;
    if (gemini5h && gemini5h.usedPct > 0 && gemini5h.resetsAt && gemini5h.resetsAt > now) {
      session = { usedPct: gemini5h.usedPct, resetsAt: gemini5h.resetsAt };
    } else if (thirdParty5h && thirdParty5h.usedPct > 0 && thirdParty5h.resetsAt && thirdParty5h.resetsAt > now) {
      session = { usedPct: thirdParty5h.usedPct, resetsAt: thirdParty5h.resetsAt };
    }

    // Third-party lockout: only locked if remaining is 0 and resetsAt is in the future
    let thirdParty = null;
    if (thirdPartyWeekly && thirdPartyWeekly.remainingPct <= 0 && thirdPartyWeekly.resetsAt && thirdPartyWeekly.resetsAt > now) {
      thirdParty = { usedPct: 100, resetsAt: thirdPartyWeekly.resetsAt };
    } else if (thirdParty5h && thirdParty5h.remainingPct <= 0 && thirdParty5h.resetsAt && thirdParty5h.resetsAt > now) {
      thirdParty = { usedPct: 100, resetsAt: thirdParty5h.resetsAt };
    }

    const flash = gemini5h ? { usedPct: gemini5h.usedPct, resetsAt: gemini5h.resetsAt } : null;

    return {
      at: now,
      email: user.email.toLowerCase(),
      plan: user.userTier?.name ?? null,
      session,
      weekly,
      flash,
      credits,
      thirdParty,
      models: {
        gemini: { weekly: geminiWeekly, session: gemini5h },
        claude: { weekly: thirdPartyWeekly, session: thirdParty5h },
      },
    };
  }

  // Fallback: parse clientModelConfigs from GetUserStatus
  const buckets = { premium: null, flash: null };
  for (const model of user.cascadeModelConfigData?.clientModelConfigs ?? []) {
    if (model.disabled) continue;
    const quota = model.quotaInfo;
    const resetsAt = Date.parse(quota?.resetTime ?? "");
    if (!Number.isFinite(resetsAt)) continue;
    const remaining = Math.min(1, Math.max(0, quota.remainingFraction ?? 0));
    const key = /flash/i.test(model.label ?? "") ? "flash" : "premium";
    const current = buckets[key];
    if (!current || remaining < current.remaining || (remaining === current.remaining && resetsAt > current.resetsAt)) {
      buckets[key] = { remaining, resetsAt, label: model.label };
    }
  }

  // Flash window: if Flash models exist, track their usage level.
  let flashWindow = null;
  if (buckets.flash) {
    const usedPct = Math.round((1 - buckets.flash.remaining) * 1000) / 10;
    flashWindow = { usedPct, resetsAt: buckets.flash.resetsAt };
  }

  const premium = classify(buckets.premium, now);
  const flashClassified = classify(buckets.flash, now);

  // Weekly lockout:
  // If premium models have a reset days away, check whether the account still has Flash or credits.
  // When Flash is usable or credits exist, do not lock out the whole account; note it as a 3rd-party lockout.
  let weekly = premium.weekly;
  let thirdParty = null;
  if (weekly) {
    const hasRemainingFlash = buckets.flash && buckets.flash.remaining > 0;
    const hasCredits = credits && ((credits.prompt ?? 0) > 0 || (credits.flow ?? 0) > 0);
    if (hasRemainingFlash || hasCredits) {
      thirdParty = weekly;
      weekly = null;
    }
  }

  const session = premium.session ?? (weekly ? null : flashClassified.session);

  return {
    at: now,
    email: user.email.toLowerCase(),
    plan: user.userTier?.name ?? null,
    session,
    weekly,
    flash: flashClassified.session ?? flashClassified.weekly ?? flashWindow,
    credits,
    thirdParty,
  };
}

/**
 * Polls every running Antigravity language server. Discovery spawns a process, so the servers
 * found are reused until a request to them fails.
 */
export function createAntigravityCollector({ onReading, intervalMs = 60_000, discover = findLanguageServers, fetchStatus = fetchUserStatus, now = Date.now }) {
  let servers = [];
  let timer = null;
  const status = { state: "starting", checkedAt: null, error: null };

  async function poll() {
    try {
      if (!servers.length) servers = await discover();
      if (!servers.length) {
        Object.assign(status, { state: "not-running", checkedAt: now(), error: null });
        return;
      }
      const results = await Promise.allSettled(servers.map((s) => fetchStatus(s)));
      const readings = results.filter((r) => r.status === "fulfilled").map((r) => toReading(r.value, now())).filter(Boolean);
      if (results.some((r) => r.status === "rejected")) servers = [];
      const seen = new Set();
      for (const reading of readings) {
        if (seen.has(reading.email)) continue;
        seen.add(reading.email);
        onReading(reading);
      }
      const failure = results.find((r) => r.status === "rejected");
      Object.assign(status, {
        state: readings.length ? "ok" : "error",
        checkedAt: now(),
        error: readings.length ? null : failure?.reason?.message ?? "No account in response",
      });
    } catch (err) {
      servers = [];
      Object.assign(status, { state: "error", checkedAt: now(), error: err.message });
    }
  }

  return {
    status,
    poll,
    start() {
      poll();
      timer = setInterval(poll, intervalMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
