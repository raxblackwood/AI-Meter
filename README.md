# AI Usage Dashboard

A local dashboard that shows how much AI coding usage is left on each account, per 5-hour session and per week, and suggests where to work next.
It tracks one Claude Pro account (Claude Code) and three Google AI Pro accounts (Antigravity).

## Run

Requires Node 24.2 or newer. There are no dependencies to install.

```bash
npm start
```

Then open http://localhost:4317.
The server only listens on 127.0.0.1.
Set `PORT` to change the port and `AI_USAGE_DATA_DIR` to keep data somewhere other than `./data`.

## Feeding Claude Code automatically

Claude Code passes `rate_limits.five_hour` and `rate_limits.seven_day` (percent used and reset time) to its status line command.
`statusline.js` records those readings into `data/claude-feed.jsonl` and prints a short status line.
Add this to `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "node E:/CODES/ai-usage-dashboard/statusline.js"
}
```

The feed works whether or not the dashboard server is running.
Usage from claude.ai chat shares the same pool but only shows up the next time Claude Code refreshes its status line.

## Logging Antigravity

Antigravity has no usage API, so use the Quick log form.
Copy the used percentage and the "refreshes in" time from the quota page.
Deleted entries can be restored with Undo for a few seconds.

## How the numbers are worked out

- **Sessions left this week**: learned from Claude Code readings where the session and weekly percentages moved together.
  It appears after about half a session of use has been observed.
  Antigravity has no weekly signal, so it is not counted.
- **Next up**: an open window with capacity left comes first, soonest reset first, because it is lost when it resets.
  Then an account with no open window.
  Otherwise, whichever account reopens soonest.
- **Active session**: the most recent window with a measured burn rate, projected forward to when it runs out.

## Data files

| File | Written by | Contents |
| --- | --- | --- |
| `data/claude-feed.jsonl` | `statusline.js` | One line per change in Claude Code's limits |
| `data/claude-latest.json` | `statusline.js` | Last reading and when it was last seen |
| `data/manual-entries.json` | `server.js` | Quick log entries |

## Test

```bash
npm test
```
