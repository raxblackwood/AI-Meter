// Desktop app: runs the collectors and the local server, shows the dashboard in a window, and lives
// in the system tray so readings keep coming while the window is closed.
import { app, BrowserWindow, dialog, Menu, nativeImage, shell, Tray } from "electron";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, DEFAULT_PORT } from "../server.js";
import { createHub } from "../src/hub.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || DEFAULT_PORT;
const URL = `http://127.0.0.1:${PORT}`;
const startHidden = process.argv.includes("--hidden");

let win = null;
let tray = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.whenReady().then(start);
}

function loginItemOptions(openAtLogin) {
  // When run from source, Windows must start electron.exe with the app folder.
  return app.isPackaged
    ? { openAtLogin, args: ["--hidden"] }
    : { openAtLogin, path: process.execPath, args: [app.getAppPath(), "--hidden"] };
}

function startsWithWindows() {
  return app.getLoginItemSettings(loginItemOptions(true)).openAtLogin;
}

/** Turns on start-with-Windows the first time the app runs; after that the tray menu decides. */
function enableAutostartOnce() {
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
    title: "AI Usage",
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
  // Closing the window keeps the app running in the tray.
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
}

function buildTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open dashboard", click: showWindow },
    { type: "separator" },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: startsWithWindows(),
      click: (item) => {
        app.setLoginItemSettings(loginItemOptions(item.checked));
        buildTrayMenu();
      },
    },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(join(HERE, "tray.png")));
  tray.setToolTip("AI Usage");
  tray.on("click", showWindow);
  buildTrayMenu();
}

async function start() {
  app.setAppUserModelId("com.raxblackwood.ai-usage-dashboard");
  const hub = createHub();
  const server = createApp({ hub, port: PORT });
  server.on("error", (err) => {
    dialog.showErrorBox("AI Usage", err.code === "EADDRINUSE"
      ? `Port ${PORT} is already in use. Close the other copy of the dashboard (for example \`npm start\`) and try again.`
      : err.message);
    quitting = true;
    app.quit();
  });
  server.listen(PORT, "127.0.0.1", () => {
    hub.start();
    enableAutostartOnce();
    createTray();
    createWindow();
  });
  app.on("before-quit", () => {
    quitting = true;
    hub.stop();
    server.close();
  });
}

// Keep running in the tray when every window is closed.
app.on("window-all-closed", () => {});
