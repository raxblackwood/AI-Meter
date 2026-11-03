// The floating meter: a slim always-on-top pill on the right edge of the screen, two rings per account.
// It replaces tray icons. The window is wider than the pill so the hover card fits; the transparent part
// lets clicks through to whatever is underneath.
import { BrowserWindow, ipcMain, Menu, screen } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAccounts } from "../src/store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WIDTH = 380;
const MIN_HEIGHT = 48;
const EDGE_GAP = 0;

/** Saved meter settings: its vertical position, whether it is shown, and the accounts left out of it. */
function settingsStore(dir) {
  const path = join(dir, "meter.json");
  const read = () => {
    try {
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    } catch {
      return {};
    }
  };
  return { read, write: (changes) => writeFileSync(path, JSON.stringify({ ...read(), ...changes })) };
}

/**
 * `url` is the meter page, `userData` the app's settings folder, `onOpen` opens the dashboard, and
 * `menuItems.top()/bottom()` are the shared menu entries (open, start with Windows, quit).
 */
export function createMeter({ url, userData, onOpen, menuItems }) {
  const settings = settingsStore(userData);
  let height = MIN_HEIGHT;
  let win = null;

  const workArea = () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;

  /** Keeps the window against the right edge, inside the work area, at the saved height on screen. */
  function place(y) {
    if (!win) return;
    const area = screen.getPrimaryDisplay().workArea;
    const defaultY = area.y + Math.round((area.height - height) / 2);
    const savedY = settings.read().y;
    // Prefer savedY only when it sits safely within the visible work area, avoiding taskbar occlusion
    const candidateY = y ?? (savedY !== undefined && savedY >= area.y && savedY <= area.y + area.height - height - 40 ? savedY : defaultY);
    const top = Math.min(Math.max(candidateY, area.y), area.y + area.height - height);
    win.setBounds({ x: area.x + area.width - WIDTH - EDGE_GAP, y: Math.round(top), width: WIDTH, height });
  }

  function hiddenIds() {
    return settings.read().hidden ?? [];
  }

  function setHidden(id, hide) {
    const set = new Set(hiddenIds());
    if (hide) set.add(id);
    else set.delete(id);
    settings.write({ hidden: [...set] });
    win.webContents.send("meter:hidden-changed", [...set]);
  }

  const isVisible = () => settings.read().visible !== false;

  /** Hides or shows the meter and remembers the choice; the dashboard has a button to bring it back. */
  function setVisible(visible) {
    settings.write({ visible });
    if (!win) return;
    if (!visible) {
      win.hide();
      return;
    }
    place();
    win.showInactive();
    win.setAlwaysOnTop(true, "floating");
    // Click-through with pointer forwarding has to be set on the shown window; set before showing,
    // Windows drops the forwarding and the meter stops reacting to the mouse.
    win.setIgnoreMouseEvents(true, { forward: true });
  }

  function showMenu() {
    const hidden = new Set(hiddenIds());
    const accounts = readAccounts().filter((a) => !a.removedAt);
    const checklist = accounts.map((a) => ({
      label: a.name,
      type: "checkbox",
      checked: !hidden.has(a.id),
      click: (item) => setHidden(a.id, !item.checked),
    }));
    Menu.buildFromTemplate([
      ...menuItems.top(),
      { label: "Hide meter", click: () => setVisible(false) },
      { label: "Center on screen", click: () => { settings.write({ y: null }); place(); } },
      { type: "separator" },
      ...(checklist.length ? [{ label: "Show in meter", submenu: checklist }, { type: "separator" }] : []),
      ...menuItems.bottom(),
    ]).popup({ window: win });
  }

  function create() {
    win = new BrowserWindow({
      width: WIDTH,
      height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      // Never takes focus away from the app you are working in.
      focusable: false,
      show: false,
      title: "AI Meter",
      webPreferences: { preload: join(HERE, "meter-preload.cjs"), contextIsolation: true, sandbox: true },
    });
    win.setAlwaysOnTop(true, "floating");
    win.setIgnoreMouseEvents(true, { forward: true });
    place();
    win.loadURL(url);
    win.once("ready-to-show", () => {
      if (isVisible()) {
        place();
        win.showInactive();
        win.setAlwaysOnTop(true, "floating");
        win.setIgnoreMouseEvents(true, { forward: true });
      }
    });

    screen.on("display-metrics-changed", () => place());
    screen.on("display-removed", () => place());
  }

  ipcMain.on("meter:interactive", (_event, on) => win?.setIgnoreMouseEvents(!on, { forward: true }));
  ipcMain.on("meter:height", (_event, px) => {
    if (!win || !Number.isFinite(px)) return;
    height = Math.max(MIN_HEIGHT, Math.min(Math.round(px), workArea().height));
    place();
  });
  ipcMain.on("meter:open", () => onOpen());
  ipcMain.on("meter:menu", () => showMenu());
  ipcMain.on("meter:hide", () => setVisible(false));

  // Dragging: the page reports start, moves and end; the window follows the cursor up and down only,
  // stays on the right edge, and remembers where it was left.
  let drag = null;
  ipcMain.on("meter:drag-start", () => {
    if (win) drag = { cursorY: screen.getCursorScreenPoint().y, windowY: win.getBounds().y };
  });
  ipcMain.on("meter:drag-move", () => {
    if (drag) place(drag.windowY + screen.getCursorScreenPoint().y - drag.cursorY);
  });
  ipcMain.on("meter:drag-end", () => {
    if (!drag) return;
    drag = null;
    settings.write({ y: win.getBounds().y });
  });
  ipcMain.handle("meter:hidden", () => hiddenIds());

  return {
    create,
    isVisible,
    setVisible,
    destroy: () => win?.destroy(),
  };
}
