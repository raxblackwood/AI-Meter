---
summary: "Local Node dashboard that tracks remaining Claude Code and Antigravity usage per 5-hour session and per week, and suggests which account to use next."
workspace: "E:\\CODES\\ai-usage-dashboard"
stack: "Node 24 (no dependencies), vanilla HTML/CSS/JS ES modules, node:test"
type: project-hub
---

# AI Usage Dashboard

> [!ABSTRACT] Quick Summary (Token-Saving Preview)
> **Scope**: Personal planner for AI coding quotas across 1 Claude Pro account (Claude Code) and 3 Google AI Pro accounts (Antigravity 1, 2, 3).
> **Stack**: Node 24 local server with no dependencies, vanilla JS front end, JSON/JSONL files for storage.
> **Contains**: Status, milestone progress, verified facts, open issues and next steps.
> **Skip if**: Your task is unrelated to AI usage limits, session planning or **AI Usage Dashboard**.

- **Status**: #project #active
- **Origin idea**: [[ai-usage-dashboard]]
- **Sub-Documents**: [[AI Usage Dashboard - Architecture|Architecture]] | [[AI Usage Dashboard - Decisions|Decisions]] | [[AI Usage Dashboard - Identity|Project Identity]]
- **Repository**: `E:\CODES\ai-usage-dashboard`, GitHub https://github.com/raxblackwood/Ai-usage-dashboard (branch `main`, first commit `3cf75cf` on 2026-10-28)

## Current Status (2026-10-28)

- **Milestone**: v1.1, automatic Antigravity reading, built and verified live against the running Antigravity IDE.
  The signed-in account auto-linked to Antigravity 1 and showed its real weekly lockout and Flash quota.
  Claude Code is still not feeding, because the status line is not wired into `~/.claude/settings.json` yet.
- **Run**: `npm start`, then open http://localhost:4317.
- **Tests**: `npm test`, 22 passing (model, Antigravity collector and parsing, status line feeder, API, static serving).

## Milestones

- [x] Promote the idea to a registered project (2026-10-28).
- [x] Verify what Claude Code exposes: the status line JSON includes `rate_limits.five_hour` and `rate_limits.seven_day` with `used_percentage` and `resets_at` (epoch seconds), confirmed in Claude Code 2.1.302.
- [x] v1: local server, status line feeder, quick log, weekly map, planner strip, undo for entries.
- [x] v1.1: Antigravity collector reading the local language server every minute, readings stored by email, auto-linking to rows, relink with undo, Flash secondary bar, weekly lockout display (2026-10-28).
- [ ] Wire `statusline.js` into `~/.claude/settings.json` (needs Rax's OK, it is a global setting).
- [ ] Sign in to Antigravity accounts 2 and 3 once each so they get linked.
- [ ] Use it for 1 to 2 weeks and check the calibration, lockout handling and suggestions against reality.
- [ ] v2 candidates: start the server automatically at login; optional Claude fallback via `/api/oauth/usage` when Claude Code is closed.

## Verified Facts

- Claude Code 2.1.302 passes `rate_limits` to the status line command for subscribers, after the first API response, only while a window is present and its reset has not passed.
- Claude Code runs on Windows 11.
- Subscription plans (Claude Pro, Google AI Pro) have no official usage API.
  API-key dashboards rely on official billing APIs that only cover pay-per-token API use, not plan quotas.
- **Antigravity local endpoint (verified 2026-10-28, probe approved by Rax)**:
  - `language_server.exe` takes `--csrf_token`; `--https_server_port` was `0` on a later launch, so the port is random and must be looked up from the OS (it listened on 4 localhost ports).
  - `POST /exa.language_server_pb.LanguageServerService/GetUserStatus` with header `X-Codeium-Csrf-Token` and body `{"metadata":{"ideName":"antigravity","extensionName":"antigravity","locale":"en"}}` returns 200 over HTTPS on one port (self-signed certificate) and over plain HTTP on another.
  - The response has `userStatus.email`, `userTier.name` ("Google AI Pro"), and per model `cascadeModelConfigData.clientModelConfigs[].quotaInfo` with `resetTime` (ISO UTC) and `remainingFraction`.
  - Models share quota groups: Gemini Flash variants together (5-hour reset); Claude Sonnet, Claude Opus and GPT-OSS together (reset about 2 days out on 2026-10-28, a weekly lockout).
  - `remainingFraction` was absent in every quota; protobuf JSON omits zero values, so the app reads it as 0% left.
    Rax approved building on this; not yet compared side by side with the IDE quota page.
  - "Gemini 4 Argon" returned an empty `quotaInfo` and is ignored.
  - Only the signed-in account is reported.
- Rejected: logging in to Google or Anthropic from this app through their official clients' OAuth (against their terms, risks the accounts).

## Known Limitations

- Antigravity is read only while the IDE is open and only for the signed-in account; other accounts keep their last reading.
- The Antigravity endpoint is undocumented and may change with Antigravity updates; Quick log remains the fallback.
- Antigravity weekly usage is only visible as a lockout (0% left with a reset days away), not as a percentage, so it is not counted in "Sessions left this week".
- Antigravity window start times are assumed to be 5 hours before the reset, for drawing only.
- claude.ai chat usage shares the Claude pool but only appears when Claude Code next refreshes its status line.
- Weekly percentages from Claude are integers, so calibration is coarse until several sessions are observed.

## Next Steps

1. Get approval and add the `statusLine` entry to `~/.claude/settings.json`.
2. Sign in to each Antigravity account once with the dashboard running, and check the rows are linked correctly.
3. Compare the dashboard with the IDE quota page after a window resets, to confirm the 0% reading and the lockout detection.
