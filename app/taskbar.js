// Taskbar badges: one tray icon per account with what is left in its window, next to the clock.
// When no account badge is shown, a single app icon stands in so the app can still be opened and quit.
import { app, Menu, nativeImage, Tray } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountView, DAY } from "../public/model.js";
import { badgeFor, renderBadge } from "../src/badges.js";
import { readAccounts, readReadings, readSeen } from "../src/store.js";

const REFRESH_MS = 30_000;
// Windows picks the representation for the display scale: 100%, 150% and 200%.
const SIZES = [[16, 1], [24, 1.5], [32, 2]];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function badgeImage(badge) {
  const image = nativeImage.createEmpty();
  for (const [size, scaleFactor] of SIZES) {
    image.addRepresentation({ scaleFactor, width: size, height: size, buffer: renderBadge(badge, size) });
  }
  return image;
}

/** Which accounts the user hid from the taskbar, kept with the app's own settings. */
function preferences() {
  const path = join(app.getPath("userData"), "taskbar.json");
  const read = () => {
    try {
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    } catch {
      return {};
    }
  };
  return {
    hidden: () => new Set(read().hidden ?? []),
    setHidden: (id, hidden) => {
      const set = new Set(read().hidden ?? []);
      if (hidden) set.add(id);
      else set.delete(id);
      writeFileSync(path, JSON.stringify({ ...read(), hidden: [...set] }));
    },
  };
}

/**
 * `menuItems(accounts)` returns the shared menu entries (open, start with Windows, quit); this module adds
 * the "Show in taskbar" checklist. `appIcon` is the plain app icon, `onClick` opens the dashboard.
 */
export function createTaskbar({ hub, appIcon, onClick, menuItems }) {
  const prefs = preferences();
  const trays = new Map(); // account id -> Tray
  let appTray = null;
  let timer = null;

  function menuFor(accounts) {
    const hidden = prefs.hidden();
    const checklist = accounts.map((a) => ({
      label: a.name,
      type: "checkbox",
      checked: !hidden.has(a.id),
      click: (item) => {
        prefs.setHidden(a.id, !item.checked);
        refresh();
      },
    }));
    return Menu.buildFromTemplate([
      ...menuItems.top(),
      ...(checklist.length ? [{ label: "Show in taskbar", submenu: checklist }, { type: "separator" }] : []),
      ...menuItems.bottom(refresh),
    ]);
  }

  function newTray(image, id) {
    // A stable id per account lets Windows remember where the user placed that icon.
    if (UUID.test(id)) {
      try {
        return new Tray(image, id);
      } catch {
        // The id is tied to the executable path; if Windows refuses it, fall back to an unnamed icon.
      }
    }
    return new Tray(image);
  }

  function refresh() {
    const now = Date.now();
    const accounts = readAccounts().filter((a) => !a.removedAt);
    const snapshots = readReadings();
    const seen = readSeen();
    const hidden = prefs.hidden();
    const shown = accounts.filter((a) => !hidden.has(a.id));
    const menu = menuFor(accounts);

    for (const [id, tray] of trays) {
      if (!shown.some((a) => a.id === id)) {
        tray.destroy();
        trays.delete(id);
      }
    }
    for (const account of shown) {
      const view = accountView(account, snapshots, now, now, now + DAY);
      const badge = badgeFor(view, hub.status[account.id], seen[account.id]);
      const image = badgeImage(badge);
      let tray = trays.get(account.id);
      if (!tray) {
        tray = newTray(image, account.id);
        tray.on("click", onClick);
        trays.set(account.id, tray);
      } else {
        tray.setImage(image);
      }
      tray.setToolTip(badge.tooltip);
      tray.setContextMenu(menu);
    }

    if (trays.size && appTray) {
      appTray.destroy();
      appTray = null;
    } else if (!trays.size) {
      appTray ??= new Tray(appIcon);
      appTray.setToolTip("AI Usage");
      appTray.removeAllListeners("click");
      appTray.on("click", onClick);
      appTray.setContextMenu(menu);
    }
  }

  return {
    start() {
      refresh();
      timer = setInterval(refresh, REFRESH_MS);
    },
    refresh,
    stop() {
      clearInterval(timer);
      for (const tray of trays.values()) tray.destroy();
      appTray?.destroy();
    },
  };
}
