// Reads Claude usage with this browser's own claude.ai sign-in and sends it to the dashboard on this
// computer. It reads the same endpoints claude.ai's Settings > Usage page reads, and sends them only to
// 127.0.0.1. The dashboard does the parsing, so this stays small and rarely needs updating.
const CLAUDE = "https://claude.ai";
const DASHBOARD = "http://127.0.0.1:4317/api/connector/claude";
const ALARM = "read-usage";
const PERIOD_MINUTES = 3;

/** The personal subscription organization (same rule as the dashboard's src/claude.js). */
function pickOrganization(orgs) {
  if (!Array.isArray(orgs) || !orgs.length) return null;
  const has = (org, cap) => Array.isArray(org.capabilities) && org.capabilities.includes(cap);
  return orgs.find((o) => has(o, "claude_max") || has(o, "claude_pro")) ?? orgs.find((o) => has(o, "chat")) ?? orgs[0];
}

async function claudeJson(path) {
  const res = await fetch(`${CLAUDE}${path}`, { credentials: "include", headers: { accept: "application/json" } });
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  if (res.status === 401 || (res.status === 403 && isJson)) throw Object.assign(new Error("Not signed in to claude.ai"), { signedOut: true });
  if (!res.ok || !isJson) throw new Error(`claude.ai returned ${res.status}`);
  return res.json();
}

async function send(payload) {
  let res;
  try {
    res = await fetch(DASHBOARD, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  } catch {
    throw new Error("Dashboard not reachable");
  }
  if (!res.ok) throw new Error(`Dashboard returned ${res.status}`);
}

async function readUsage() {
  const { lastEmail = null } = await chrome.storage.local.get("lastEmail");
  const status = { checkedAt: Date.now(), email: lastEmail, error: null, signedOut: false, sent: false };
  try {
    const org = pickOrganization(await claudeJson("/api/organizations"));
    if (!org?.uuid) throw new Error("No Claude organization on this account");
    const account = await claudeJson("/api/account").catch(() => null);
    const usage = await claudeJson(`/api/organizations/${org.uuid}/usage`);
    const email = account?.email_address ?? account?.email ?? lastEmail;
    await send({ account, orgId: org.uuid, usage, email });
    Object.assign(status, { email, sent: true });
    await chrome.storage.local.set({ lastEmail: email });
  } catch (err) {
    status.error = err.message;
    status.signedOut = Boolean(err.signedOut);
    // Tell the dashboard the account it knew about is signed out, so its row can say so.
    if (err.signedOut && lastEmail) await send({ email: lastEmail, signedOut: true }).catch(() => {});
  }
  await chrome.storage.local.set({ status });
  return status;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MINUTES });
  readUsage();
});
chrome.runtime.onStartup.addListener(readUsage);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) readUsage();
});
// The popup asks for a fresh reading when it opens.
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message === "read-now") {
    readUsage().then(reply);
    return true;
  }
  return false;
});
