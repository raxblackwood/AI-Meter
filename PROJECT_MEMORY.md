---
summary: "Desktop tray app that tracks remaining Claude and Antigravity usage per 5-hour session and per week across any number of accounts, and suggests which account to use next."
workspace: "E:\\CODES\\ai-usage-dashboard"
stack: "Electron 45 tray app + Node 24 local server (no runtime deps), vanilla JS UI, Chrome MV3 extension, node:test"
type: project-hub
---

# AI Usage Dashboard

> [!ABSTRACT] Quick Summary (Token-Saving Preview)
> **Scope**: Personal planner for AI coding quotas across any number of Claude and Antigravity accounts, fully automatic.
> **Stack**: Electron tray app hosting a Node local server; Claude read by a browser extension; Antigravity read from its local language server.
> **Contains**: Status, milestone progress, verified facts, open issues and next steps.
> **Skip if**: Your task is unrelated to AI usage limits, session planning or **AI Usage Dashboard**.

- **Status**: #project #active
- **Origin idea**: [[ai-usage-dashboard]]
- **Sub-Documents**: [[AI Usage Dashboard - Architecture|Architecture]] | [[AI Usage Dashboard - Decisions|Decisions]] | [[AI Usage Dashboard - Identity|Project Identity]]
- **Repository**: `E:\CODES\ai-usage-dashboard`, GitHub https://github.com/raxblackwood/Ai-usage-dashboard (branch `main`)

## Current Status (2026-10-28)

- **Milestone**: v0.2, desktop app with automatic multi-account tracking.
  - Electron tray app (`npm run app`), starts with Windows, window hides to tray.
  - Antigravity: verified live with two accounts (both auto-detected as separate rows).
  - Claude: browser extension built (`extension/`); waiting for Rax to load it in Chrome for the first live reading.
  - Manual logging and the Claude Code status line were removed at Rax's request (he uses the Claude desktop app, not the terminal; status line entry removed from `~/.claude/settings.json`).
- **Tests**: `npm test`, 30 passing.

## Rax's Requirements (2026-10-28)

- Fully automatic; no manual logging.
- Scalable to any number of accounts per provider, added by logging in.
- Logins must happen in his normal browser (already signed in to Google there), not in a separate app window that asks for his password again.

## Milestones

- [x] v1: local server, weekly map, planner strip (2026-10-28).
- [x] v1.1: Antigravity read automatically from the local language server (2026-10-28).
- [x] v0.2: Electron tray app, dynamic accounts (rename, remove, restore), Claude via browser extension, migration of v1 data (2026-10-28).
- [x] In-app Claude sign-in window tried and dropped: Google sign-in there needed his password again.
- [x] Single "Add account" button with an AI picker (Claude: extension steps; Antigravity: sign in once in Antigravity), per Rax's feedback (2026-10-28).
- [x] Decided with Rax (2026-10-28): keep the browser extension and publish it on the Chrome Web Store. A browser OAuth login is not possible: Anthropic restricts Pro/Max OAuth to Claude Code and claude.ai (Feb 2026), and Google suspends accounts that reuse Antigravity's sign-in.
- [x] Store prep: `npm run pack-extension` (zip in `dist/`), `PRIVACY.md`, `docs/chrome-web-store.md` (listing, permission justifications, data disclosures), `config.chromeWebStoreUrl` in package.json switches Add account > Claude to an install button.
- [x] Both ways to connect Claude (ADR-011): in-app sign-in window restored as an option next to the extension; verified the window opens from Add account > Claude (2026-10-28). 36 tests.
- [x] Layout redesign per Rax (ADR-012): one Next up focal card, simpler rows, start time on every bar, 3 days / Week switch, lockouts plan from the exact unlock time (2026-10-28). 36 tests.
- [ ] Rax: register a Chrome Web Store developer account (USD 5), host `PRIVACY.md` publicly (repo is private), add screenshots, submit after the first live reading works.
- [x] Extension now reports its failures (`{ email?, signedOut, error }`) to `POST /api/connector/claude`; the app shows the reason in the header and the Add account panel (`connector.error`, cleared by the next good reading) (2026-10-28).
- [x] First live Claude reading through the extension (2026-10-28, 20:48): Rax's account loaded in **Edge** became "Claude 1" with 5-hour 42% used and weekly 39% used, matching `five_hour` / `seven_day` with `utilization` and `resets_at`, and `/api/account` `email_address`. The app showed it in Next up and Active session. One earlier report was rejected (cause not captured); rejection diagnostics (`connector.error`, `connector.rejectedShape`, field names only) stay in place for the next time. (verify `/api/organizations/{org}/usage` shape and that extension fetches carry the claude.ai cookies).
- [ ] Use it for 1 to 2 weeks and check calibration, lockout handling and suggestions against reality.
- [ ] Later: package an installer (electron-builder) so it does not run from the source folder; optionally publish the extension.

## Verified Facts

- Subscription plans (Claude Pro, Google AI Pro) have no official usage API; API-key dashboards use billing APIs that do not cover plan quotas.
- **Antigravity local endpoint (verified 2026-10-28)**: `language_server.exe` takes `--csrf_token`; `--https_server_port` can be `0`, so ports are looked up from the OS.
  `POST /exa.language_server_pb.LanguageServerService/GetUserStatus` (header `X-Codeium-Csrf-Token`) answers on one of its loopback ports over HTTPS (self-signed) or HTTP.
  Response: `userStatus.email`, `userTier.name`, per model `quotaInfo { resetTime, remainingFraction }`; missing fraction means 0.
  Quota groups: Flash models together (5-hour), Claude/GPT-OSS models together; a reset days away is a weekly lockout (seen: 2 days and 7 days).
- Using Antigravity's Google OAuth from third-party tools led to many reported account suspensions (Google AI developer forum, 2026), so the app never signs in to Google.
- **Claude (verified live 2026-10-28)**: `claude.ai/api/organizations/{orgId}/usage` returns `five_hour` / `seven_day` with `utilization` (percent) and `resets_at`; `/api/account` gives `email_address`. Extension fetches from Edge carry the claude.ai session.

## Known Limitations

- Antigravity is read only while the IDE is open and only for the signed-in account; other accounts keep their last reading and reset times.
- Claude readings arrive only while the browser with the extension is open; one Claude account per browser profile.
- Both sources are undocumented and may change; the row shows an error when a read fails.
- Antigravity weekly usage is only visible as a lockout, so it is not counted in "Sessions left this week".
- The app runs from the source folder via `electron.exe`; autostart points there.

## Next Steps

1. Rax loads `extension/` in Chrome (Developer mode, Load unpacked) and confirms the Claude row appears.
2. Fix anything the first live Claude reading reveals.
3. Package an installer when the data sources have proven stable.
