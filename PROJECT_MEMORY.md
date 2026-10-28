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
- **Repository**: `E:\CODES\ai-usage-dashboard`

## Current Status (2026-10-28)

- **Milestone**: v1 built and tested end to end with demo data.
  Not yet used with real data, because the Claude Code status line is not wired into `~/.claude/settings.json` yet.
- **Run**: `npm start`, then open http://localhost:4317.
- **Tests**: `npm test`, 13 passing (model, status line feeder, API, static serving).

## Milestones

- [x] Promote the idea to a registered project (2026-10-28).
- [x] Verify what Claude Code exposes: the status line JSON includes `rate_limits.five_hour` and `rate_limits.seven_day` with `used_percentage` and `resets_at` (epoch seconds), confirmed in Claude Code 2.1.302.
- [x] v1: local server, status line feeder, quick log for Antigravity, weekly map, planner strip, undo for entries.
- [ ] Wire `statusline.js` into `~/.claude/settings.json` (needs Rax's OK, it is a global setting).
- [ ] Use it for 1 to 2 weeks and check the calibration and suggestions against reality.
- [ ] v2 candidates: start the server automatically at login, investigate any way to read Antigravity quota automatically.

## Verified Facts

- Claude Code 2.1.302 passes `rate_limits` to the status line command for subscribers, after the first API response, only while a window is present and its reset has not passed.
- The idea note's open question about the OS is answered: Windows 11.

## Known Limitations

- Antigravity has no weekly signal, so its weekly budget is not tracked and its "possible next windows" are not capped.
- Antigravity window start times are assumed to be 5 hours before the logged reset, for drawing only.
- claude.ai chat usage shares the Claude pool but only appears when Claude Code next refreshes its status line.
- Weekly percentages from Claude are integers, so calibration is coarse until several sessions are observed.

## Next Steps

1. Get approval and add the `statusLine` entry to `~/.claude/settings.json`.
2. Run the dashboard daily and log Antigravity readings from the quota page.
3. After a week, review whether "Sessions left this week" matches what actually happened.
