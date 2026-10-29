# AI Usage Dashboard

A desktop app that shows how much AI coding usage is left on each of your accounts, per 5-hour session and per week, and suggests which account to use next.
It reads Claude and Antigravity on its own; there is nothing to log by hand.

## Run

Requires Node 24.2 or newer.

```bash
npm install
npm run app
```

The app opens a window and stays in the system tray when the window is closed.
On first run it turns on **Start with Windows**; untick it in the tray menu to stop that.
The dashboard is also available at http://127.0.0.1:4317 while the app runs.

`npm start` runs the same dashboard without the tray (useful for development).

## Claude accounts

There are two ways to connect a Claude account; pick per account under **Add account > Claude**.

- **Sign in here**: opens a claude.ai sign-in window inside the app.
  Use email (Claude sends a code) or Google (asks for the password once).
  Each account gets its own private session in the app, and the app reads its usage every 3 minutes.
- **Use your browser**: the browser extension below, which reuses the sign-in you already have in your browser.

If the same email is connected both ways, it stays one row.

### The browser extension

Claude limits are shared by the desktop app, claude.ai and the phone, so they are read from your Claude account itself.
A small browser extension in `extension/` does this with the claude.ai sign-in you already have in your browser, so there is no password to enter.
Every 3 minutes it reads the numbers behind claude.ai's Settings > Usage page and sends them only to this app on 127.0.0.1.

To connect, click **Add Claude account** in the app, or:

1. In Chrome or Edge, open `chrome://extensions` (or `edge://extensions`) and turn on Developer mode.
2. Click **Load unpacked** and choose the `extension` folder of this repository.
3. Be signed in at claude.ai in that browser. The account appears within a minute.

Each browser profile reports the Claude account it is signed in to, so for more Claude accounts, load the extension in each profile.
Readings arrive while that browser is open.

The extension is being prepared for the Chrome Web Store so other people can install it in one click; see [docs/chrome-web-store.md](docs/chrome-web-store.md) and [PRIVACY.md](PRIVACY.md).
`npm run pack-extension` builds the upload zip in `dist/`.
Once published, put the store link in `package.json` under `config.chromeWebStoreUrl` and Add account > Claude shows an install button.

## Antigravity accounts: automatic

While Antigravity is open, the app reads its quota once a minute from Antigravity's own local language server, the same source as the IDE quota page.
It finds the `language_server` process, takes its CSRF token from the process arguments (kept in memory only), looks up the localhost ports it listens on, and calls `GetUserStatus`.

- Only the signed-in account is reported, and each new email becomes its own row.
  An account's quota only drops while you use it, which is when it is signed in, so every account stays tracked; the others count down to their known reset times.
- Claude, GPT-OSS and other non-Flash models drive the main bar; Flash models show as a thin second bar.
- A reset more than about 5 hours away is shown as a weekly lockout.

The app does not sign in to Google itself: tools that reuse Antigravity's Google sign-in have led to accounts being suspended.

## Taskbar badges

Each account also gets a small icon next to the clock showing what is left in its current 5-hour window:
blue with the percent left, amber at 25% or less, red at 5% or less, green "100" when no window is running, a red padlock while locked, and "?" when it cannot be read.
Hover for the details; click to open the dashboard.
The tray menu has **Show in taskbar** to choose which accounts get an icon.

Windows 11 puts new icons in the hidden-icons area (the ^ arrow).
Drag them onto the taskbar, or turn them on in Settings > Personalization > Taskbar > Other system tray icons (they are listed as "Electron" while the app runs from source).

## Accounts

Each row has a menu with **Rename** and **Remove**.
Removed accounts keep their history and can be restored from the line under the map.

## How the numbers are worked out

- **Sessions left this week**: learned from Claude readings where the session and weekly percentages moved together; it appears after about half a session of use has been observed.
  Antigravity reports a weekly limit only as a lockout, so it is not counted.
- **Next up**: an open window with capacity left comes first, soonest reset first, because it is lost when it resets.
  Then an account with no open window, otherwise whichever account reopens soonest.
- **Active session**: the most recent window with a measured burn rate, projected forward to when it runs out.

These sources are not public APIs and can change with Claude or Antigravity updates; the affected row then shows an error.

## Data files

All in `data/` (set `AI_USAGE_DATA_DIR` to move it); only the app writes them.

| File | Contents |
| --- | --- |
| `accounts.json` | The accounts: provider, name, email, removed time |
| `readings.jsonl` | One line per change in an account's limits |
| `latest.json` | Last reading per account and when it was seen |

## Development

```bash
npm test
node scripts/make-icons.mjs
```
