import { accountView, DAY, MINUTE, summarize } from "./model.js";

const REFRESH_MS = 30_000;
// While the setup panel is open, check often so a new account shows up as soon as it reports.
const CONNECT_REFRESH_MS = 3_000;
const UNDO_MS = 8_000;
// The weekly map shows yesterday plus the next six days.
const SPAN_DAYS_BEFORE = 1;
const SPAN_DAYS = 7;
// An Antigravity reading older than this means that account is not the one signed in right now.
const CURRENT_WITHIN_MS = 3 * MINUTE;
const PROVIDER_ORDER = { claude: 0, antigravity: 1 };

const $ = (id) => document.getElementById(id);
let state = null;
let toastTimer = null;
let undoAction = null;
let refreshTimer = null;
let openMenuId = null;
let renamingId = null;

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

function sortedAccounts() {
  return [...state.accounts].sort((a, b) =>
    (PROVIDER_ORDER[a.provider] ?? 9) - (PROVIDER_ORDER[b.provider] ?? 9) || a.createdAt - b.createdAt);
}

function render() {
  if (!state) return;
  const now = Date.now();
  const spanStart = startOfDay(now) - SPAN_DAYS_BEFORE * DAY;
  const spanEnd = spanStart + SPAN_DAYS * DAY;
  const views = sortedAccounts().map((a) => accountView(a, state.snapshots, now, spanStart, spanEnd));

  renderHeader(now);
  renderSummary(summarize(views, now), now);
  renderBoard(views, now, spanStart, spanEnd);
  renderRemoved();
}

function renderRemoved() {
  const removed = state.removed ?? [];
  $("removed").hidden = !removed.length;
  $("removed").innerHTML = removed.length
    ? `Removed: ${removed.map((a) => `<span class="removed-item">${esc(a.name)}
        <button type="button" class="link-button" data-restore="${esc(a.id)}" aria-label="Restore ${esc(a.name)}">Restore</button></span>`).join("")}`
    : "";
}

function renderHeader(now) {
  const parts = [];
  const claude = state.accounts.filter((a) => a.provider === "claude");
  const reported = state.connector.claudeSeenAt;
  if (claude.length || reported) {
    const problems = claude.filter((a) => state.status[a.id]?.state === "signed-out").length;
    parts.push(problems ? `Claude: ${problems} of ${claude.length} signed out`
      : reported ? `Claude: browser reported ${ago(now - reported)}`
      : "Claude: waiting for the browser extension (is the browser open?)");
  }
  const ag = state.antigravity;
  const current = state.accounts.find((a) => a.provider === "antigravity" && now - (state.seen[a.id] ?? 0) <= CURRENT_WITHIN_MS);
  parts.push(ag.state === "ok" && current ? `Antigravity: reading ${current.email}`
    : ag.state === "not-running" ? "Antigravity is not open"
    : ag.state === "error" ? `Antigravity unreadable: ${ag.error}`
    : "Antigravity: checking");
  $("feed-status").textContent = parts.join(" · ");
  renderConnect(now);
}

function renderConnect(now) {
  $("extension-dir").textContent = state.connector.extensionDir;
  // Once the extension is published, the store is the main way in and the folder steps are a fallback.
  const storeUrl = state.connector.storeUrl;
  $("store-install").hidden = !storeUrl;
  if (storeUrl) $("store-link").href = storeUrl;
  $("manual-summary").textContent = storeUrl ? "Or install from folder" : "Install from folder";
  if (!storeUrl && !$("manual-install").dataset.initialized) {
    $("manual-install").open = true;
    $("manual-install").dataset.initialized = "1";
  }
  const reported = state.connector.claudeSeenAt;
  const claude = state.accounts.filter((a) => a.provider === "claude");
  $("connect-status").textContent = reported
    ? `Connected. The extension last reported ${ago(now - reported)}${claude.length ? `; accounts: ${claude.map((a) => a.email ?? a.name).join(", ")}` : ""}.`
    : "Waiting for the extension. This updates on its own once it is loaded.";
  $("connect-status").classList.toggle("connect-ok", Boolean(reported));

  const ag = state.antigravity;
  const agAccounts = state.accounts.filter((a) => a.provider === "antigravity");
  const current = agAccounts.find((a) => now - (state.seen[a.id] ?? 0) <= CURRENT_WITHIN_MS);
  $("antigravity-status").textContent = ag.state === "ok" && current
    ? `Antigravity is open and signed in as ${current.email}. Tracked accounts: ${agAccounts.length}.`
    : ag.state === "not-running" ? "Antigravity is not open right now."
    : "Checking Antigravity...";
  $("antigravity-status").classList.toggle("connect-ok", ag.state === "ok" && Boolean(current));
}

function toggleConnect(open) {
  $("connect").hidden = !open;
  $("add-account").setAttribute("aria-expanded", String(open));
  if (!open) selectProvider(null);
  clearTimeout(refreshTimer);
  load();
}

/** Shows the steps for one AI in the Add account panel, or none. */
function selectProvider(provider) {
  for (const option of document.querySelectorAll("[data-provider]")) {
    option.setAttribute("aria-checked", String(option.dataset.provider === provider));
  }
  for (const steps of document.querySelectorAll("[data-steps]")) {
    steps.hidden = steps.dataset.steps !== provider;
  }
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
    tiles.push(tile("Next up", "-", "Add an account to get suggestions."));
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
    const rate = `${pct(a.session.burnPerHour)}/h, `;
    tiles.push(a.session.projectedFullAt
      ? tile("Active session", `Full by ~${when(a.session.projectedFullAt, now)}`,
        `${esc(a.account.name)}: ${rate}${pct(a.session.usedPct)} used. Resets ${when(a.session.resetsAt, now)}.`, "tile-warn")
      : tile("Active session", `Lasts to ${when(a.session.resetsAt, now)}`,
        `${esc(a.account.name)}: ${rate}${pct(a.session.usedPct)} used. At this pace the window resets first.`));
  } else {
    tiles.push(tile("Active session", "None", "No session used in the last 30 minutes."));
  }

  const left = summary.sessionsLeft;
  const untracked = left.unknown.length ? ` Not counted: ${esc(left.unknown.join(", "))}.` : "";
  tiles.push(left.known
    ? tile("Sessions left this week", sessions(left.total), `Full 5-hour sessions the weekly caps still allow.${untracked}`)
    : tile("Sessions left this week", "-", state.accounts.some((x) => x.provider === "claude")
      ? "Learning how much of the weekly cap a session costs. Needs about half a session of Claude use."
      : "Add a Claude account to estimate this."));

  const next = summary.nextReset;
  tiles.push(tile("Ready now", `${summary.readyCount} of ${state.accounts.length}`,
    next ? `Next reset: ${esc(next.account.name)} at ${when(next.session.resetsAt, now)}.` : "No open windows."));

  $("summary").innerHTML = tiles.join("");
}

function accountMeta(v, now) {
  const lines = [];
  const status = state.status[v.account.id];
  const seen = state.seen[v.account.id];

  if (status?.state === "signed-out") {
    lines.push(`<span class="text-danger">Signed out of claude.ai in the browser</span>`);
  } else if (status?.state === "error") {
    lines.push(`<span class="text-danger">Could not read: ${esc(status.error)}</span>`);
  }

  if (v.session.state === "open") {
    lines.push(`<span class="num">${pct(100 - v.session.usedPct)}</span> left, resets ${when(v.session.resetsAt, now)}`);
  } else if (!v.exhausted && seen) {
    lines.push("No open window, ready to start");
  }
  if (v.exhausted) {
    lines.push(`<span class="text-danger">Weekly limit hit</span>, unlocks ${when(v.weekly.resetsAt, now)}`);
  } else if (v.weekly?.resetsAt) {
    lines.push(`Week <span class="num">${pct(v.weekly.usedPct)}</span> used, resets ${when(v.weekly.resetsAt, now)}`);
  } else if (v.account.provider === "antigravity" && seen) {
    lines.push(`<span class="muted-2">No weekly lock</span>`);
  }
  if (v.flash) {
    lines.push(`Flash <span class="num">${pct(100 - v.flash.usedPct)}</span> left, resets ${when(v.flash.resetsAt, now)}`);
  }
  if (v.sessionsLeft !== null) {
    lines.push(`<span class="num">${sessions(v.sessionsLeft)}</span> sessions left this week`);
  } else if (v.account.provider === "claude" && seen) {
    lines.push(`<span class="muted-2">Calibrating (${pct(v.calibration.observedSessionPct)} of 50% observed)</span>`);
  }

  if (!seen) {
    lines.push(`<span class="muted-2">${v.account.provider === "claude" ? "Waiting for the first reading" : "Not read yet"}</span>`);
  } else if (v.account.provider === "antigravity" && now - seen > CURRENT_WITHIN_MS) {
    lines.push(`<span class="muted-2">Last read ${ago(now - seen)}, updates when you use it in Antigravity</span>`);
  } else {
    lines.push(`<span class="muted-2">Updated ${ago(now - seen)}</span>`);
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
    default: return `${v.account.name}, ${range}: beyond the weekly budget or locked`;
  }
}

function rowHead(v) {
  const a = v.account;
  const status = state.status[a.id]?.state;
  const remaining = v.exhausted ? 0 : v.session.state === "open" ? 100 - v.session.usedPct : 100;
  const meterTone = v.exhausted || remaining <= 5 ? "meter-empty" : remaining <= 25 ? "meter-low" : "";
  const subtitle = a.email ?? state.providers[a.provider]?.plan ?? "";
  const title = renamingId === a.id
    ? `<input class="rename-input" data-rename="${esc(a.id)}" value="${esc(a.name)}" maxlength="40" aria-label="Account name">`
    : `<h3>${esc(a.name)}</h3>`;
  const signInAgain = a.provider === "claude" && status === "signed-out"
    ? `<a class="btn btn-primary btn-small" href="https://claude.ai/login" target="_blank" rel="noopener">Sign in</a>` : "";
  const menu = openMenuId === a.id
    ? `<div class="menu" role="menu">
        <button type="button" role="menuitem" data-action="rename" data-id="${esc(a.id)}">Rename</button>
        <button type="button" role="menuitem" class="menu-danger" data-action="remove" data-id="${esc(a.id)}">Remove</button>
      </div>` : "";
  const flashBar = v.flash
    ? `<div class="meter meter-thin" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(100 - v.flash.usedPct)}" aria-label="${esc(a.name)} Flash left">
        <span style="width:${100 - v.flash.usedPct}%"></span>
      </div>` : "";
  return `<div class="row-head">
      <div class="row-title">
        <div class="row-name">${title}<span class="muted-2" title="${esc(subtitle)}">${esc(subtitle)}</span></div>
        <div class="row-actions">
          ${signInAgain}
          <button type="button" class="btn btn-ghost btn-icon" data-menu="${esc(a.id)}" aria-haspopup="menu" aria-expanded="${openMenuId === a.id}" aria-label="Options for ${esc(a.name)}">&#8943;</button>
          ${menu}
        </div>
      </div>
      <div class="meters">
        <div class="meter ${meterTone}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(remaining)}" aria-label="${esc(a.name)} session left">
          <span style="width:${remaining}%"></span>
        </div>
        ${flashBar}
      </div>
      <div class="row-meta">${accountMeta(v, Date.now())}</div>
    </div>`;
}

function renderBoard(views, now, spanStart, spanEnd) {
  const span = spanEnd - spanStart;
  const x = (t) => ((Math.min(Math.max(t, spanStart), spanEnd) - spanStart) / span) * 100;

  const days = [];
  for (let i = 0; i < SPAN_DAYS; i++) {
    const t = spanStart + i * DAY;
    const d = new Date(t);
    days.push(`<div class="day ${t === startOfDay(now) ? "day-today" : ""}" style="left:${x(t)}%;width:${100 / SPAN_DAYS}%">
      <span>${d.toLocaleDateString([], { weekday: "short" })}</span>
      <span class="num">${d.getDate()}</span>
    </div>`);
  }
  const gridLines = Array.from({ length: SPAN_DAYS - 1 }, (_, i) =>
    `<span class="gridline" style="left:${x(spanStart + (i + 1) * DAY)}%"></span>`).join("");
  const nowLine = `<span class="now-line" style="left:${x(now)}%"></span>`;

  const rows = views.map((v) => {
    // Until an account has been read there is nothing to plan.
    const windows = state.seen[v.account.id] ? v.windows : [];
    const blocks = windows
      .filter((w) => w.end > spanStart && w.start < spanEnd)
      .map((w) => {
        const left = x(w.start);
        const width = x(w.end) - left;
        const fill = w.kind === "current" || w.kind === "past" ? 100 - w.usedPct : w.kind === "over" ? 0 : w.capacityPct;
        const title = esc(blockTitle(w, v, now));
        return `<span class="block block-${w.kind}" style="left:${left}%;width:${width}%" title="${title}" aria-label="${title}" role="img">
          <span class="block-fill" style="height:${fill}%"></span>
        </span>`;
      }).join("");
    const weekly = v.weekly?.resetsAt && v.weekly.resetsAt < spanEnd
      ? `<span class="weekly-mark" style="left:${x(v.weekly.resetsAt)}%" title="Weekly reset ${esc(when(v.weekly.resetsAt, now))}"></span>` : "";
    return `${rowHead(v)}<div class="track">${gridLines}${blocks}${weekly}${nowLine}</div>`;
  }).join("");

  const empty = views.length ? "" : `<div class="empty">
      <h3>No accounts yet</h3>
      <p class="muted">Use <strong>Add account</strong> to add Claude or Antigravity.</p>
    </div>`;

  const focusKey = focusSelector(document.activeElement);
  $("board").innerHTML = `<div class="axis-spacer"></div><div class="axis">${days.join("")}${nowLine}</div>${rows}${empty}`;
  // Redrawing replaces the elements, so put keyboard focus back on the same control.
  if (focusKey) document.querySelector(focusKey)?.focus();
}

/** A selector that finds the same control after a redraw, or null if it is not one of the board's. */
function focusSelector(el) {
  if (!el?.closest?.("#board")) return null;
  for (const attr of ["data-rename", "data-menu"]) {
    if (el.hasAttribute(attr)) return `[${attr}="${CSS.escape(el.getAttribute(attr))}"]`;
  }
  if (el.dataset.action) return `[data-action="${CSS.escape(el.dataset.action)}"][data-id="${CSS.escape(el.dataset.id)}"]`;
  return null;
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
    // Do not redraw under the user while they type a new name or use a menu.
    if (!renamingId && !openMenuId) render();
    else renderHeader(Date.now());
  } catch (err) {
    $("feed-status").textContent = `Cannot reach the dashboard: ${err.message}`;
  }
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(load, $("connect").hidden ? REFRESH_MS : CONNECT_REFRESH_MS);
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

async function finishRename(id, save) {
  const input = document.querySelector(`[data-rename="${CSS.escape(id)}"]`);
  const name = input?.value.trim();
  renamingId = null;
  const account = state.accounts.find((a) => a.id === id);
  if (save && name && account && name !== account.name) {
    try {
      await api("PATCH", `/api/accounts/${id}`, { name });
    } catch (err) {
      showToast(err.message, null);
    }
  }
  await load();
  render();
}

// ---------- events ----------

$("add-account").addEventListener("click", () => toggleConnect($("connect").hidden));
for (const option of document.querySelectorAll("[data-provider]")) {
  option.addEventListener("click", () => selectProvider(option.dataset.provider));
}
$("connect-close").addEventListener("click", () => {
  toggleConnect(false);
  $("add-account").focus();
});
$("copy-dir").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(state.connector.extensionDir);
    showToast("Folder path copied.", null);
  } catch {
    showToast("Could not copy. Select the path and copy it instead.", null);
  }
});

document.addEventListener("click", async (event) => {
  const menuButton = event.target.closest("[data-menu]");
  if (menuButton) {
    openMenuId = openMenuId === menuButton.dataset.menu ? null : menuButton.dataset.menu;
    render();
    document.querySelector(".menu button")?.focus();
    return;
  }
  const item = event.target.closest("[data-action]");
  if (item) {
    const id = item.dataset.id;
    openMenuId = null;
    if (item.dataset.action === "rename") {
      renamingId = id;
      render();
      const input = document.querySelector(`[data-rename="${CSS.escape(id)}"]`);
      input?.focus();
      input?.select();
    } else if (item.dataset.action === "remove") {
      try {
        const removed = await api("DELETE", `/api/accounts/${id}`);
        await load();
        showToast(`Removed ${removed.name}. You can restore it below the map.`, () => api("POST", `/api/accounts/${id}/restore`));
      } catch (err) {
        showToast(err.message, null);
      }
    }
    return;
  }
  const restore = event.target.closest("[data-restore]");
  if (restore) {
    try {
      await api("POST", `/api/accounts/${restore.dataset.restore}/restore`);
      await load();
    } catch (err) {
      showToast(err.message, null);
    }
    return;
  }
  if (openMenuId && !event.target.closest(".menu")) {
    openMenuId = null;
    render();
  }
});

document.addEventListener("keydown", (event) => {
  const input = event.target.closest?.("[data-rename]");
  if (input && (event.key === "Enter" || event.key === "Escape")) {
    event.preventDefault();
    finishRename(input.dataset.rename, event.key === "Enter");
  } else if (event.key === "Escape" && openMenuId) {
    const id = openMenuId;
    openMenuId = null;
    render();
    document.querySelector(`[data-menu="${CSS.escape(id)}"]`)?.focus();
  }
});

document.addEventListener("focusout", (event) => {
  const input = event.target.closest?.("[data-rename]");
  if (input && renamingId === input.dataset.rename) finishRename(input.dataset.rename, true);
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
// Keep the "now" line and countdowns moving between data refreshes.
setInterval(() => !renamingId && !openMenuId && render(), REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") load();
});
