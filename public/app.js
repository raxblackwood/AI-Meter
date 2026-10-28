import { accountView, DAY, MINUTE, summarize } from "./model.js";

const REFRESH_MS = 30_000;
const UNDO_MS = 8_000;
// The weekly map shows yesterday plus the next six days.
const SPAN_DAYS_BEFORE = 1;
const SPAN_DAYS = 7;

const $ = (id) => document.getElementById(id);
let state = null;
let toastTimer = null;
let undoAction = null;

// ---------- formatting ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** "14:20" today, "Tue 14:20" within a week, otherwise "Tue 3 Nov 14:20". */
function when(ms, now) {
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / DAY);
  if (days === 0) return clock(ms);
  const d = new Date(ms);
  const weekday = d.toLocaleDateString([], { weekday: "short" });
  if (Math.abs(days) < 7) return `${weekday} ${clock(ms)}`;
  return `${weekday} ${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${clock(ms)}`;
}

function duration(ms) {
  const total = Math.max(0, Math.round(ms / MINUTE));
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

const ago = (ms) => (ms < MINUTE ? "just now" : `${duration(ms)} ago`);
const pct = (n) => `${Math.round(n)}%`;
const sessions = (n) => (n >= 10 ? n.toFixed(0) : n.toFixed(1));

// ---------- rendering ----------

function render() {
  if (!state) return;
  const now = Date.now();
  const spanStart = startOfDay(now) - SPAN_DAYS_BEFORE * DAY;
  const spanEnd = spanStart + SPAN_DAYS * DAY;
  const views = state.accounts.map((a) => accountView(a, state.snapshots, now, spanStart, spanEnd));
  const summary = summarize(views, now);

  renderFeedStatus(now);
  renderSummary(summary, now);
  renderBoard(views, now, spanStart, spanEnd);
  renderEntries(now);
}

function renderFeedStatus(now) {
  const seen = state.feedSeenAt;
  $("feed-status").textContent = seen
    ? `Claude Code feed seen ${ago(now - seen)}`
    : "Claude Code feed not connected yet. Set statusline.js as your status line.";
}

function tile(label, value, detail, tone = "") {
  return `<article class="tile ${tone}">
    <h2 class="tile-label">${esc(label)}</h2>
    <p class="tile-value">${value}</p>
    <p class="tile-detail">${detail}</p>
  </article>`;
}

function renderSummary(summary, now) {
  const tiles = [];
  const s = summary.suggestion;
  if (!s) {
    tiles.push(tile("Next up", "-", "No accounts configured."));
  } else {
    const name = esc(s.view.account.name);
    const detail = {
      "use-open": `Use it now: ${pct(s.remainingPct)} left, window closes ${when(s.until, now)}.`,
      "start-fresh": `Start now: opens a 5-hour window until ${when(s.until, now)}.`,
      "session-wait": `All windows are used. This one reopens ${when(s.at, now)}, in ${duration(s.at - now)}.`,
      "weekly-wait": `All weekly caps are used. This one resets ${when(s.at, now)}, in ${duration(s.at - now)}.`,
    }[s.kind];
    const value = s.at <= now ? name : `${name} <span class="tile-at">at ${when(s.at, now)}</span>`;
    tiles.push(tile("Next up", value, detail, "tile-primary"));
  }

  const a = summary.active;
  if (a) {
    const rate = a.session.burnPerHour ? `${pct(a.session.burnPerHour)}/h, ` : "";
    tiles.push(a.session.projectedFullAt
      ? tile("Active session", `Full by ~${when(a.session.projectedFullAt, now)}`,
        `${esc(a.account.name)}: ${rate}${pct(a.session.usedPct)} used. Resets ${when(a.session.resetsAt, now)}.`, "tile-warn")
      : tile("Active session", `Lasts to ${when(a.session.resetsAt, now)}`, a.session.burnPerHour
        ? `${esc(a.account.name)}: ${rate}${pct(a.session.usedPct)} used. At this pace the window resets first.`
        : `${esc(a.account.name)}: ${pct(a.session.usedPct)} used. Log again later to project when it runs out.`));
  } else {
    tiles.push(tile("Active session", "None", "No session used in the last 30 minutes."));
  }

  const left = summary.sessionsLeft;
  const untracked = left.unknown.length ? ` Not counted: ${esc(left.unknown.join(", "))}.` : "";
  tiles.push(left.known
    ? tile("Sessions left this week", sessions(left.total), `Full 5-hour sessions the weekly caps still allow.${untracked}`)
    : tile("Sessions left this week", "-", "Calibrating. Needs about half a session of Claude Code use with the feed on."));

  const next = summary.nextReset;
  tiles.push(tile("Ready now", `${summary.readyCount} of ${state.accounts.length}`,
    next ? `Next reset: ${esc(next.account.name)} at ${when(next.session.resetsAt, now)}.` : "No open windows."));

  $("summary").innerHTML = tiles.join("");
}

function accountMeta(v, now) {
  const lines = [];
  if (v.session.state === "open") {
    lines.push(`<span class="num">${pct(100 - v.session.usedPct)}</span> left, resets ${when(v.session.resetsAt, now)}`);
  } else {
    lines.push("No open window, ready to start");
  }
  if (v.weekly) {
    lines.push(v.weekly.resetsAt
      ? `Week <span class="num">${pct(v.weekly.usedPct)}</span> used, resets ${when(v.weekly.resetsAt, now)}`
      : "Week reset, waiting for new data");
  } else {
    lines.push(`<span class="muted-2">Weekly cap not tracked</span>`);
  }
  if (v.sessionsLeft !== null) {
    lines.push(`<span class="num">${sessions(v.sessionsLeft)}</span> sessions left this week`);
  } else if (v.account.feed === "statusline") {
    lines.push(`<span class="muted-2">Calibrating (${pct(v.calibration.observedSessionPct)} of 50% observed)</span>`);
  }
  if (v.lastSeenAt && v.account.feed === "manual") {
    lines.push(`<span class="muted-2">Logged ${ago(now - v.lastSeenAt)}</span>`);
  }
  return lines.map((l) => `<span>${l}</span>`).join("");
}

function blockTitle(w, v, now) {
  const range = `${when(w.start, now)} - ${when(w.end, now)}`;
  switch (w.kind) {
    case "current": return `${v.account.name}, current window ${range}: ${pct(100 - w.usedPct)} left`;
    case "past": return `${v.account.name}, ${range}: peaked at ${pct(w.usedPct)}, ${pct(100 - w.usedPct)} unused`;
    case "planned": return `${v.account.name}, possible window ${range}`;
    case "partial": return `${v.account.name}, possible window ${range}: about ${pct(w.capacityPct)} of a session left in the weekly budget`;
    default: return `${v.account.name}, ${range}: beyond the weekly budget`;
  }
}

function renderBoard(views, now, spanStart, spanEnd) {
  const span = spanEnd - spanStart;
  const x = (t) => ((Math.min(Math.max(t, spanStart), spanEnd) - spanStart) / span) * 100;

  const days = [];
  for (let i = 0; i < SPAN_DAYS; i++) {
    const t = spanStart + i * DAY;
    const isToday = t === startOfDay(now);
    const d = new Date(t);
    days.push(`<div class="day ${isToday ? "day-today" : ""}" style="left:${x(t)}%;width:${100 / SPAN_DAYS}%">
      <span>${d.toLocaleDateString([], { weekday: "short" })}</span>
      <span class="num">${d.getDate()}</span>
    </div>`);
  }
  const gridLines = Array.from({ length: SPAN_DAYS - 1 }, (_, i) =>
    `<span class="gridline" style="left:${x(spanStart + (i + 1) * DAY)}%"></span>`).join("");
  const nowLine = `<span class="now-line" style="left:${x(now)}%"></span>`;

  const rows = views.map((v) => {
    const blocks = v.windows
      .filter((w) => w.end > spanStart && w.start < spanEnd)
      .map((w) => {
        const left = x(w.start);
        const width = x(w.end) - left;
        const fill = w.kind === "current" ? 100 - w.usedPct
          : w.kind === "past" ? 100 - w.usedPct
          : w.kind === "over" ? 0 : w.capacityPct;
        const title = esc(blockTitle(w, v, now));
        return `<span class="block block-${w.kind}" style="left:${left}%;width:${width}%" title="${title}" aria-label="${title}" role="img">
          <span class="block-fill" style="height:${fill}%"></span>
        </span>`;
      }).join("");
    const weekly = v.weekly?.resetsAt && v.weekly.resetsAt < spanEnd
      ? `<span class="weekly-mark" style="left:${x(v.weekly.resetsAt)}%" title="Weekly reset ${esc(when(v.weekly.resetsAt, now))}"></span>`
      : "";
    const remaining = v.session.state === "open" ? 100 - v.session.usedPct : 100;
    const meterTone = v.exhausted || remaining <= 5 ? "meter-empty" : remaining <= 25 ? "meter-low" : "";
    const logButton = v.account.feed === "manual"
      ? `<button type="button" class="btn btn-ghost btn-small" data-log="${esc(v.account.id)}" aria-label="Log ${esc(v.account.name)}">Log</button>`
      : `<span class="badge" title="Updated by the Claude Code status line">Auto</span>`;
    return `<div class="row-head">
        <div class="row-title">
          <div><h3>${esc(v.account.name)}</h3><span class="muted-2">${esc(v.account.plan)}</span></div>
          ${logButton}
        </div>
        <div class="meter ${meterTone}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(remaining)}" aria-label="${esc(v.account.name)} session left">
          <span style="width:${remaining}%"></span>
        </div>
        <div class="row-meta">${accountMeta(v, now)}</div>
      </div>
      <div class="track">${gridLines}${blocks}${weekly}${nowLine}</div>`;
  }).join("");

  $("board").innerHTML = `<div class="axis-spacer"></div><div class="axis">${days.join("")}${nowLine}</div>${rows}`;
}

function renderEntries(now) {
  const names = Object.fromEntries(state.accounts.map((a) => [a.id, a.name]));
  const recent = state.entries.slice(0, 8);
  $("entries").innerHTML = recent.length
    ? recent.map((e) => `<li>
        <span><strong>${esc(names[e.accountId] ?? e.accountId)}</strong>
        <span class="muted">${pct(e.session.usedPct)} used, refreshes ${when(e.session.resetsAt, now)}</span></span>
        <span class="entry-side"><span class="muted-2">${when(e.at, now)}</span>
        <button type="button" class="btn btn-ghost btn-small" data-delete="${esc(e.id)}" aria-label="Delete entry">Delete</button></span>
      </li>`).join("")
    : `<li class="muted">No manual entries yet.</li>`;
}

// ---------- data ----------

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function load() {
  try {
    state = await api("GET", "/api/state");
    populateAccounts();
    render();
  } catch (err) {
    $("feed-status").textContent = `Cannot reach the dashboard server: ${err.message}`;
  }
}

function populateAccounts() {
  const select = $("log-account");
  if (select.options.length) return;
  for (const a of state.accounts) {
    const opt = new Option(a.name, a.id);
    select.add(opt);
  }
  select.value = state.accounts.find((a) => a.feed === "manual")?.id ?? state.accounts[0].id;
}

function showToast(text, undo) {
  $("toast-text").textContent = text;
  $("toast").hidden = false;
  $("toast-undo").hidden = !undo;
  undoAction = undo;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, UNDO_MS);
}

function hideToast() {
  $("toast").hidden = true;
  undoAction = null;
}

// ---------- events ----------

$("log-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const usedPct = Number(data.get("usedPct"));
  const minutes = Number(data.get("hours") || 0) * 60 + Number(data.get("minutes") || 0);
  $("log-error").textContent = "";
  if (data.get("usedPct") === "" || !(usedPct >= 0 && usedPct <= 100)) {
    $("log-error").textContent = "Enter the used percentage, from 0 to 100.";
    $("log-used").focus();
    return;
  }
  if (!(minutes > 0)) {
    $("log-error").textContent = "Enter when the quota refreshes.";
    form.elements.hours.focus();
    return;
  }
  try {
    const entry = await api("POST", "/api/entries", {
      accountId: data.get("accountId"),
      usedPct,
      resetsAt: Date.now() + minutes * MINUTE,
    });
    for (const name of ["usedPct", "hours", "minutes"]) form.elements[name].value = "";
    await load();
    showToast(`Logged ${state.accounts.find((a) => a.id === entry.accountId)?.name}.`, async () => {
      await api("DELETE", `/api/entries/${entry.id}`);
    });
  } catch (err) {
    $("log-error").textContent = err.message;
  }
});

document.addEventListener("click", async (event) => {
  const logBtn = event.target.closest("[data-log]");
  if (logBtn) {
    $("log-account").value = logBtn.dataset.log;
    $("log-used").focus();
    $("log-used").scrollIntoView({ block: "center", behavior: "smooth" });
    return;
  }
  const delBtn = event.target.closest("[data-delete]");
  if (delBtn) {
    try {
      const removed = await api("DELETE", `/api/entries/${delBtn.dataset.delete}`);
      await load();
      showToast("Entry deleted.", async () => {
        await api("POST", "/api/entries", removed.session && {
          id: removed.id, accountId: removed.accountId, at: removed.at,
          usedPct: removed.session.usedPct, resetsAt: removed.session.resetsAt,
        });
      });
    } catch (err) {
      showToast(err.message, null);
    }
  }
});

$("toast-undo").addEventListener("click", async () => {
  const undo = undoAction;
  hideToast();
  if (!undo) return;
  try {
    await undo();
    await load();
  } catch (err) {
    showToast(`Undo failed: ${err.message}`, null);
  }
});

load();
setInterval(load, REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") load();
});
