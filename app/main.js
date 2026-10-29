// AI Meter desktop app: runs the collectors and the local server, shows the dashboard in a window, and
// keeps a floating meter on the right edge of the screen. There is no tray icon; the meter's right-click
// menu opens the dashboard, sets start-with-Windows and quits.
import { app, BrowserWindow, dialog, shell } from "electron";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, DEFAULT_PORT } from "../server.js";
import { createHub } from "../src/hub.js";
import { claudeClient } from "./claude-client.js";
import { createMeter } from "./meter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || DEFAULT_PORT;
const URL = `http://127.0.0.1:${PORT}`;
const APP_ID = "com.raxblackwood.ai-meter";
// The app was called "AI Usage" before; its startup entry had this name.
const OLD_APP_ID = "com.raxblackwood.ai-usage-dashboard";
const startHidden = process.argv.includes("--hidden");

let win = null;
let meter = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.whenReady().then(start);
}

function loginItemOptions(openAtLogin, name = APP_ID) {
  // When run from source, Windows must start electron.exe with the app folder.
  return app.isPackaged
    ? { openAtLogin, name, args: ["--hidden"] }
    : { openAtLogin, name, path: process.execPath, args: [app.getAppPath(), "--hidden"] };
}

function startsWithWindows() {
  return app.getLoginItemSettings(loginItemOptions(true)).openAtLogin;
}

/** Turns on start-with-Windows the first time the app runs; after that the meter's menu decides. */
function setUpAutostart() {
  // Drop the startup entry made under the old name, so the app does not start twice.
  app.setLoginItemSettings(loginItemOptions(false, OLD_APP_ID));
  const marker = join(app.getPath("userData"), "autostart-initialized");
  if (existsSync(marker)) return;
  app.setLoginItemSettings(loginItemOptions(true));
  writeFileSync(marker, new Date().toISOString());
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 720,
    minHeight: 560,
    title: "AI Meter",
    show: !startHidden,
    backgroundColor: "#09090b",
    autoHideMenuBar: true,
    icon: join(HERE, "icon.png"),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.loadURL(URL);
  // Links to other sites open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // Closing the window keeps the app (and the floating meter) running.
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
}

/** Menu entries around the meter's "Show in meter" checklist. */
const menuItems = {
  top: () => [{ label: "Open dashboard", click: showWindow }, { type: "separator" }],
  bottom: () => [
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: startsWithWindows(),
      click: (item) => app.setLoginItemSettings(loginItemOptions(item.checked)),
    },
    { type: "separator" },
    { label: "Quit AI Meter", click: () => { quitting = true; app.quit(); } },
  ],
};

async function start() {
  app.setAppUserModelId(APP_ID);
  const hub = createHub({ claudeClient });
  const server = createApp({ hub, port: PORT });
  server.on("error", (err) => {
    dialog.showErrorBox("AI Meter", err.code === "EADDRINUSE"
      ? `Port ${PORT} is already in use. Close the other copy of the dashboard (for example \`npm start\`) and try again.`
      : err.message);
    quitting = true;
    app.quit();
  });
  server.listen(PORT, "127.0.0.1", () => {
    hub.start();
    setUpAutostart();
    meter = createMeter({ url: `${URL}/meter.html`, userData: app.getPath("userData"), onOpen: showWindow, menuItems });
    meter.create();
    createWindow();
  });
  app.on("before-quit", () => {
    quitting = true;
    hub.stop();
    meter?.destroy();
    server.close();
  });
}

// Keep running (with the floating meter) when the dashboard window is closed.
app.on("window-all-closed", () => {});
