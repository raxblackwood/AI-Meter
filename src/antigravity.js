// Reads Antigravity quota from its local language server, the same source the IDE quota page uses.
// The server is started by Antigravity with a `--csrf_token` argument and answers `GetUserStatus`
// on one of the localhost ports it listens on. `--https_server_port` is often 0 (picked at random),
// so the listening ports are looked up from the OS. This is not a public API, so every step fails soft.
// The CSRF token is only held in memory; it is never logged or written to disk.
import { execFile } from "node:child_process";
import http from "node:http";
import https from "node:https";

const STATUS_PATH = "/exa.language_server_pb.LanguageServerService/GetUserStatus";
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

function post(lib, port, csrfToken) {
  return new Promise((resolve, reject) => {
    const req = lib.request({
      host: "127.0.0.1",
      port,
      path: STATUS_PATH,
      method: "POST",
      // The language server uses a self-signed certificate on loopback.
      rejectUnauthorized: false,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        "content-type": "application/json",
        "connect-protocol-version": "1",
        "x-codeium-csrf-token": csrfToken,
        "content-length": Buffer.byteLength(STATUS_BODY),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`GetUserStatus returned ${res.statusCode}`));
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new Error("GetUserStatus returned invalid JSON"));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("GetUserStatus timed out")));
    req.on("error", reject);
    req.end(STATUS_BODY);
  });
}

/**
 * Calls GetUserStatus. The server listens on several ports with different protocols, so each port is
 * tried over HTTPS and then plain HTTP. The endpoint that answers is remembered on `server` and tried first.
 */
export async function fetchUserStatus(server) {
  const candidates = server.ports.flatMap((port) => [{ scheme: "https", port }, { scheme: "http", port }]);
  if (server.endpoint) candidates.unshift(server.endpoint);
  let firstError = null;
  for (const endpoint of candidates) {
    try {
      const result = await post(endpoint.scheme === "https" ? https : http, endpoint.port, server.csrfToken);
      server.endpoint = endpoint;
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
  const buckets = { premium: null, flash: null };
  for (const model of user.cascadeModelConfigData?.clientModelConfigs ?? []) {
    const quota = model.quotaInfo;
    const resetsAt = Date.parse(quota?.resetTime ?? "");
    if (!Number.isFinite(resetsAt)) continue;
    const remaining = Math.min(1, Math.max(0, quota.remainingFraction ?? 0));
    const key = /flash/i.test(model.label ?? "") ? "flash" : "premium";
    const current = buckets[key];
    if (!current || remaining < current.remaining || (remaining === current.remaining && resetsAt > current.resetsAt)) {
      buckets[key] = { remaining, resetsAt };
    }
  }
  const premium = classify(buckets.premium, now);
  const flash = classify(buckets.flash, now);
  return {
    at: now,
    email: user.email.toLowerCase(),
    plan: user.userTier?.name ?? null,
    session: premium.session,
    weekly: premium.weekly,
    flash: flash.session ?? flash.weekly,
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
