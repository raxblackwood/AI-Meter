// In-app Claude sign-in, the alternative to the browser extension. Each account signed in here gets its
// own persistent Electron session (partition), so any number can stay signed in side by side. The user
// signs in themselves in a normal claude.ai window; the app then reads the endpoints Settings > Usage reads.
import { BrowserWindow, session } from "electron";
import { accountEmail, pickOrganization } from "../src/claude.js";

const ORIGIN = "https://claude.ai";
const SIGN_IN_POLL_MS = 1500;

// Present as plain Chrome: some sign-in providers refuse browsers that announce Electron.
function userAgent() {
  return session.defaultSession.getUserAgent().replace(/\s(Electron|ai-usage-dashboard)\/\S+/g, "");
}

function sessionFor(partition) {
  const ses = session.fromPartition(partition);
  ses.setUserAgent(userAgent());
  return ses;
}

async function getJson(ses, path) {
  const res = await ses.fetch(`${ORIGIN}${path}`, { headers: { accept: "application/json" }, credentials: "include" });
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  if (res.status === 401 || (res.status === 403 && isJson)) {
    throw Object.assign(new Error("Signed out of Claude"), { code: "signed-out" });
  }
  if (!res.ok) throw new Error(`claude.ai returned ${res.status}${isJson ? "" : " (blocked by a browser check)"}`);
  if (!isJson) throw new Error("claude.ai did not return JSON");
  return res.json();
}

async function identify(ses) {
  const org = pickOrganization(await getJson(ses, "/api/organizations"));
  if (!org?.uuid) throw new Error("No Claude organization on this account");
  const account = await getJson(ses, "/api/account").catch(() => null);
  return { orgId: org.uuid, email: accountEmail(account) };
}

/** Opens a claude.ai sign-in window and resolves with `{ email, orgId }` once the session can read the account. */
function signIn(partition) {
  const ses = sessionFor(partition);
  const win = new BrowserWindow({
    width: 520,
    height: 760,
    title: "Sign in to Claude",
    autoHideMenuBar: true,
    webPreferences: { partition, contextIsolation: true, sandbox: true },
  });
  // Google and Apple sign-in open popups; keep them in the same session.
  win.webContents.setWindowOpenHandler(() => ({
    action: "allow",
    overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { partition, contextIsolation: true, sandbox: true } },
  }));
  win.loadURL(`${ORIGIN}/login`);

  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      fn(value);
    };
    const timer = setInterval(async () => {
      try {
        const [cookie] = await ses.cookies.get({ url: ORIGIN, name: "sessionKey" });
        if (!cookie) return;
        const identity = await identify(ses);
        finish(resolve, identity);
        if (!win.isDestroyed()) win.close();
      } catch {
        // Not signed in yet, or the account is still loading; try again on the next tick.
      }
    }, SIGN_IN_POLL_MS);
    win.on("closed", () => finish(reject, Object.assign(new Error("Sign-in window closed"), { code: "cancelled" })));
  });
}

/** Reads usage for an account signed in here. Throws with code "signed-out" when the session ended. */
async function fetchUsage(account) {
  if (!account.partition) throw Object.assign(new Error("Not signed in"), { code: "signed-out" });
  const ses = sessionFor(account.partition);
  const orgId = account.orgId ?? (await identify(ses)).orgId;
  return getJson(ses, `/api/organizations/${orgId}/usage`);
}

/** Signs an account out of the app by clearing its session. */
async function signOut(partition) {
  await session.fromPartition(partition).clearStorageData();
}

export const claudeClient = { signIn, fetchUsage, signOut };
