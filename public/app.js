import { accountView, DAY, HOUR, MINUTE, summarize } from "./model.js";

const REFRESH_MS = 30_000;
// While the setup panel is open, check often so a new account shows up as soon as it reports.
const CONNECT_REFRESH_MS = 3_000;
const UNDO_MS = 8_000;
// Time ranges for the schedule. "3d" starts a few hours back so the current window is in view.
const RANGES = {
  "3d": (now) => [now - 6 * HOUR, now - 6 * HOUR + 3 * DAY],
  week: (now) => [startOfDay(now) - DAY, startOfDay(now) + 8 * DAY],
  month: (now) => [startOfDay(now) - DAY, startOfDay(now) + 32 * DAY],
};
// Room needed for a bar's start time: "01:10" in full, or just the hour ("01") in narrow bars.
const FULL_LABEL_PX = 36;
const HOUR_LABEL_PX = 18;
// An Antigravity reading older than this means that account is not the one signed in right now.
const CURRENT_WITHIN_MS = 3 * MINUTE;
const PROVIDER_ORDER = { claude: 0, antigravity: 1, codex: 2, other: 3 };
const RANGE_KEY = "ai-usage.range";

const $ = (id) => document.getElementById(id);
let state = null;
let toastTimer = null;
let undoAction = null;
let refreshTimer = null;
let openMenuId = null;
let renamingId = null;
let activeUsageAccountId = null;
let loadError = null;
let range = readRange();

/** The remembered time range; storage can be unavailable, so fall back quietly. */
function readRange() {
  try {
    const saved = localStorage.getItem(RANGE_KEY);
    return saved in RANGES ? saved : "3d";
  } catch {
    return "3d";
  }
}

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
  const [spanStart, spanEnd] = RANGES[range](now);
  const views = sortedAccounts().map((a) => accountView(a, state.snapshots, now, spanStart, spanEnd));

  renderStatus(now);
  renderHero(summarize(views, now), views, now);
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

/**
 * The header shows one quiet freshness indicator; details live in its tooltip. Only problems the rows
 * cannot show on their own get an alert line.
 */
function renderStatus(now) {
  const alerts = [];
  if (loadError) alerts.push(`Cannot reach the dashboard: ${loadError}`);
  if (state?.connector?.error) alerts.push(`The browser extension could not read claude.ai: ${state.connector.error}`);
  if (state?.antigravity?.state === "error") alerts.push(`Antigravity could not be read: ${state.antigravity.error}`);
  $("alerts").innerHTML = alerts.map((a) => `<p class="alert">${esc(a)}</p>`).join("");

  const latest = Math.max(0, ...Object.values(state?.seen ?? {}));
  const ag = state?.antigravity;
  const current = state?.accounts?.find((a) => a.provider === "antigravity" && now - (state.seen?.[a.id] ?? 0) <= CURRENT_WITHIN_MS);
  $("live-text").textContent = loadError ? "Offline" : latest ? `Updated ${ago(now - latest)}` : "Waiting for data";
  $("live").classList.toggle("live-off", Boolean(loadError) || !latest);
  $("live").title = [
    ag?.state === "ok" && current ? `Antigravity: reading ${current.email}` : ag?.state === "not-running" ? "Antigravity: not open" : "Antigravity: checking",
    state?.signIn?.available ? "Claude: read by the app and the browser extension" : "Claude: read by the browser extension",
  ].join("\n");
  if (state) renderConnect(now);

  // The floating meter belongs to the desktop app; in a plain browser tab there is nothing to toggle.
  const toggle = $("meter-toggle");
  toggle.hidden = !state?.meter;
  if (state?.meter) toggle.textContent = state.meter.visible ? "Hide meter" : "Show meter";
}

function renderConnect(now) {
  if ($("extension-dir")) $("extension-dir").textContent = state.connector.extensionDir;
  // Once the extension is published, the store is the main way in and the folder steps are a fallback.
  const storeUrl = state.connector.storeUrl;
  if ($("store-install")) $("store-install").hidden = !storeUrl;
  if (storeUrl && $("store-link")) $("store-link").href = storeUrl;
  if ($("manual-summary")) $("manual-summary").textContent = storeUrl ? "Or install from folder" : "Install from folder";
  if (!storeUrl && $("manual-install") && !$("manual-install").dataset.initialized) {
    $("manual-install").open = true;
    $("manual-install").dataset.initialized = "1";
  }
  const reported = state.connector.claudeSeenAt;
  const claude = state.accounts.filter((a) => a.provider === "claude");
  const error = state.connector.error;
  // Accounts read through the extension, known from earlier reports even before the next one arrives.
  const viaBrowser = claude.filter((a) => !a.signedInHere && state.seen[a.id]);
  const connected = Boolean(reported) || viaBrowser.length > 0;
  if ($("connect-status")) {
    $("connect-status").textContent = !connected ? "Waiting for the extension. This updates on its own once it is loaded."
      : error ? `The extension is installed but could not read claude.ai: ${error}`
      : `Connected${viaBrowser.length ? `: ${viaBrowser.map((a) => a.email ?? a.name).join(", ")}` : ""}.`;
    $("connect-status").classList.toggle("connect-ok", connected && !error);
  }

  // Signing in inside the app works only in the desktop app, not in a plain browser tab.
  const signIn = state.signIn;
  if ($("method-app")) $("method-app").hidden = !signIn.available;
  if ($("sign-in-claude")) {
    $("sign-in-claude").disabled = signIn.pending;
    $("sign-in-claude").textContent = signIn.pending ? "Waiting for sign-in..." : "Sign in to Claude";
  }
  if ($("sign-in-status")) {
    $("sign-in-status").hidden = !signIn.pending && !signIn.error;
    $("sign-in-status").textContent = signIn.pending
      ? "Sign in in the window that opened. The account appears here as soon as you are done."
      : signIn.error ? `Sign-in did not finish: ${signIn.error}` : "";
    $("sign-in-status").classList.toggle("connect-error", Boolean(signIn.error));
  }

  const ag = state.antigravity;
  const agAccounts = state.accounts.filter((a) => a.provider === "antigravity");
  const current = agAccounts.find((a) => now - (state.seen[a.id] ?? 0) <= CURRENT_WITHIN_MS);
  if ($("antigravity-status")) {
    $("antigravity-status").textContent = ag.state === "ok" && current
      ? `Antigravity is open and signed in as ${current.email}. Tracked accounts: ${agAccounts.length}.`
      : ag.state === "not-running" ? "Antigravity is not open right now."
      : "Checking Antigravity...";
    $("antigravity-status").classList.toggle("connect-ok", ag.state === "ok" && Boolean(current));
  }

  const cx = state.codex;
  if ($("codex-detected")) {
    if (cx?.available) {
      $("codex-detected").hidden = false;
      $("codex-detected").innerHTML = `
        <div class="detected-badge-inner">
          <span class="live-dot" aria-hidden="true"></span>
          <div>
            <strong>Codex is active & tracked automatically</strong>
            <p class="muted">Signed in as <strong>${esc(cx.email)}</strong> (${esc(cx.plan)}). Quota is live on your schedule and meter with a rolling 3-hour window.</p>
          </div>
        </div>`;
      if ($("codex-desc")) $("codex-desc").hidden = true;
      if ($("codex-manual-details") && !$("codex-manual-details").dataset.userInteracted) {
        $("codex-manual-details").open = false;
      }
    } else {
      $("codex-detected").hidden = true;
      if ($("codex-desc")) $("codex-desc").hidden = false;
      if ($("codex-manual-details") && !$("codex-manual-details").dataset.userInteracted) {
        $("codex-manual-details").open = true;
      }
    }
  }
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

/** One focal point: where to work next. The projection and weekly total join it only when they exist. */
function renderHero(summary, views, now) {
  const s = summary.suggestion;
  if (!s) {
    $("hero").innerHTML = `<div class="hero-main">
        <p class="hero-label">Next up</p>
        <p class="hero-title">Add an account to begin</p>
      </div>`;
    return;
  }
  const name = esc(s.view.account.name);
  const [title, detail] = {
    "use-open": [`${name}`, `${pct(s.remainingPct)} left until ${when(s.until, now)}`],
    "start-fresh": [`${name}`, `Ready. A new window would run until ${when(s.until, now)}`],
    "session-wait": [`${name} <span class="hero-at">at ${when(s.at, now)}</span>`, `Every window is used. Opens in ${duration(s.at - now)}`],
    "weekly-wait": [`${name} <span class="hero-at">at ${when(s.at, now)}</span>`, `Weekly limits reached. Unlocks in ${duration(s.at - now)}`],
  }[s.kind];

  const side = [];
  const a = summary.active;
  if (a?.session.projectedFullAt) {
    side.push(`<div class="hero-side">
        <p class="hero-label">At this pace</p>
        <p class="hero-stat hero-warn">Full by ${when(a.session.projectedFullAt, now)}</p>
        <p class="hero-detail">${esc(a.account.name)}, ${pct(a.session.burnPerHour)} an hour</p>
      </div>`);
  }
  if (summary.sessionsLeft.known) {
    side.push(`<div class="hero-side">
        <p class="hero-label">This week</p>
        <p class="hero-stat">${sessions(summary.sessionsLeft.total)} sessions left</p>
      </div>`);
  }
  $("hero").innerHTML = `<div class="hero-main">
      <p class="hero-label">Next up</p>
      <p class="hero-title">${title}</p>
      <p class="hero-detail">${detail}</p>
    </div>${side.join("")}`;
}

/** Structured telemetry list with each limit on its own dedicated, scannable line. */
function rowSummary(v, now) {
  const status = state?.status?.[v.account.id]?.state;
  const seen = state?.seen?.[v.account.id];
  if (status === "signed-out") {
    return `<div class="quota-status quota-status-muted">Signed out</div>`;
  }
  if (status === "error") {
    const errorMsg = state?.status?.[v.account.id]?.error ?? "Error";
    return `<div class="quota-status quota-status-danger" title="${esc(errorMsg)}">Not readable</div>`;
  }
  if (!seen) {
    return `<div class="quota-status quota-status-muted">Waiting for data...</div>`;
  }

  const rows = [];

  if (v.account.provider === "antigravity") {
    // 1. Gemini Models 5-Hour Session
    if (v.session.state === "open") {
      const left = 100 - v.session.usedPct;
      const tone = left <= 5 ? "quota-val-danger" : left <= 25 ? "quota-val-warn" : "";
      rows.push(`
        <div class="quota-row">
          <span class="quota-label">Gemini 5h</span>
          <span class="quota-val ${tone}"><span class="num">${pct(left)}</span> left<span class="quota-sub">until ${when(v.session.resetsAt, now)}</span></span>
        </div>`);
    } else {
      rows.push(`
        <div class="quota-row">
          <span class="quota-label">Gemini 5h</span>
          <span class="quota-val"><span class="quota-val-ok">Ready</span><span class="quota-sub">5h on start</span></span>
        </div>`);
    }

    // 2. Gemini Models Weekly Limit
    if (v.weekly?.usedPct !== undefined) {
      const remaining = 100 - v.weekly.usedPct;
      const tone = remaining <= 5 ? "quota-val-danger" : remaining <= 25 ? "quota-val-warn" : "";
      const resetSub = v.weekly.resetsAt ? ` · resets ${when(v.weekly.resetsAt, now)}` : "";
      rows.push(`
        <div class="quota-row">
          <span class="quota-label">Gemini Wk</span>
          <span class="quota-val ${tone}"><span class="num">${pct(remaining)}</span> left<span class="quota-sub">${resetSub}</span></span>
        </div>`);
    } else if (v.weekly?.resetsAt) {
      rows.push(`
        <div class="quota-row">
          <span class="quota-label">Gemini Wk</span>
          <span class="quota-val"><span class="quota-val-ok">Ready</span><span class="quota-sub"> · resets ${when(v.weekly.resetsAt, now)}</span></span>
        </div>`);
    }

    // 3. Claude & GPT Models
    if (v.thirdParty) {
      rows.push(`
        <div class="quota-row">
          <span class="quota-label">Claude/GPT</span>
          <span class="quota-val quota-val-danger">Locked<span class="quota-sub">until ${when(v.thirdParty.resetsAt, now)}</span></span>
        </div>`);
    } else if (v.models?.claude?.weekly && v.models?.claude?.session) {
      const s = Math.round(v.models.claude.session.remainingPct);
      const w = Math.round(v.models.claude.weekly.remainingPct);
      const tone = w <= 10 ? "quota-val-danger" : w <= 25 ? "quota-val-warn" : "";
      const resetSub = v.models.claude.weekly.resetsAt ? ` · resets ${when(v.models.claude.weekly.resetsAt, now)}` : "";
      rows.push(`
        <div class="quota-row">
          <span class="quota-label">Claude/GPT</span>
          <span class="quota-val ${tone}"><span class="num">${s}%</span> 5h · <span class="num">${w}%</span> wk<span class="quota-sub">${resetSub}</span></span>
        </div>`);
    } else {
      rows.push(`
        <div class="quota-row">
          <span class="quota-label">Claude/GPT</span>
          <span class="quota-val"><span class="quota-val-ok">Ready</span></span>
        </div>`);
    }

    // 4. Credits
    if (v.credits) {
      const prompt = v.credits.prompt ?? 0;
      const flow = v.credits.flow ?? 0;
      rows.push(`
        <div class="quota-row">
          <span class="quota-label">Credits</span>
          <span class="quota-val"><span class="num">${prompt}</span> <span class="quota-sub">prompt</span> · <span class="num">${flow}</span> <span class="quota-sub">flow</span></span>
        </div>`);
    }

    // 5. Account-level weekly lockout if present
    if (v.exhausted && v.weekly?.resetsAt) {
      rows.push(`
        <div class="quota-row">
          <span class="quota-label">Account</span>
          <span class="quota-val quota-val-danger">Locked<span class="quota-sub">until ${when(v.weekly.resetsAt, now)}</span></span>
        </div>`);
    }
  } else {
    // Claude / standard providers
    // 1. Session limit
    if (v.exhausted) {
      rows.push(`
        <div class="quota-row">
          <span class="quota-label">Session</span>
          <span class="quota-val quota-val-danger">Locked<span class="quota-sub">0% left</span></span>
        </div>`);
    } else if (v.session.state === "open") {
      const left = 100 - v.session.usedPct;
      const tone = left <= 5 ? "quota-val-danger" : left <= 25 ? "quota-val-warn" : "";
      rows.push(`
        <div class="quota-row">
          <span class="quota-label">Session</span>
          <span class="quota-val ${tone}"><span class="num">${pct(left)}</span> left<span class="quota-sub">until ${when(v.session.resetsAt, now)}</span></span>
        </div>`);
    } else {
      rows.push(`
        <div class="quota-row">
          <span class="quota-label">Session</span>
          <span class="quota-val"><span class="quota-val-ok">Ready</span><span class="quota-sub">5h on start</span></span>
        </div>`);
    }

    // 2. Weekly limit
    if (v.weekly?.usedPct !== undefined) {
      const tone = v.weekly.usedPct >= 100 ? "quota-val-danger" : v.weekly.usedPct >= 80 ? "quota-val-warn" : "";
      const parts = [];
      if (v.sessionsLeft !== null) parts.push(`${sessions(v.sessionsLeft)} left`);
      if (v.weekly.resetsAt) parts.push(`resets ${when(v.weekly.resetsAt, now)}`);
      const sub = parts.join(" · ");
      rows.push(`
        <div class="quota-row">
          <span class="quota-label">Weekly</span>
          <span class="quota-val ${tone}"><span class="num">${pct(v.weekly.usedPct)}</span> used${sub ? `<span class="quota-sub">· ${sub}</span>` : ""}</span>
        </div>`);
    } else if (v.weekly?.resetsAt) {
      rows.push(`
        <div class="quota-row">
          <span class="quota-label">Weekly</span>
          <span class="quota-val"><span class="quota-val-ok">Ready</span><span class="quota-sub">· resets ${when(v.weekly.resetsAt, now)}</span></span>
        </div>`);
    }
  }

  // 3. Subscription / Plan cycle or expiry
  if (v.subscription) {
    const isEnding = v.subscription.type === "fixed";
    const tone = isEnding && v.subscription.daysLeft <= 3 ? "quota-val-warn" : "";
    rows.push(`
      <div class="quota-row">
        <span class="quota-label">Plan</span>
        <span class="quota-val ${tone}"><span class="num">${esc(v.subscription.label)}</span><span class="quota-sub">· ${esc(v.subscription.summary)}</span></span>
      </div>`);
  }

  return `<div class="quota-list">${rows.join("")}</div>`;
}

function rowHead(v, now) {
  const a = v.account;
  const status = state.status[a.id]?.state;
  const title = renamingId === a.id
    ? `<input class="rename-input" data-rename="${esc(a.id)}" value="${esc(a.name)}" maxlength="40" aria-label="Account name">`
    : `<h3>${esc(a.name)}</h3>`;
  const subtitle = a.email ?? state.providers[a.provider]?.plan ?? "";
  // A signed-out account is fixed where it was signed in: in this app, or at claude.ai in the browser.
  const appSignIn = a.signedInHere && state.signIn.available;
  const signInAgain = a.provider !== "claude" || status !== "signed-out" ? ""
    : appSignIn ? `<button type="button" class="btn btn-primary btn-small" data-sign-in="${esc(a.id)}" ${state.signIn.pending ? "disabled" : ""}>Sign in</button>`
    : `<a class="btn btn-primary btn-small" href="https://claude.ai/login" target="_blank" rel="noopener">Sign in</a>`;
  const menu = openMenuId === a.id
    ? `<div class="menu" role="menu">
        <button type="button" role="menuitem" data-action="update-usage" data-id="${esc(a.id)}">Update usage & plan</button>
        <button type="button" role="menuitem" data-action="rename" data-id="${esc(a.id)}">Rename</button>
        ${appSignIn ? `<button type="button" role="menuitem" data-action="sign-in" data-id="${esc(a.id)}">Sign in again</button>` : ""}
        <button type="button" role="menuitem" class="menu-danger" data-action="remove" data-id="${esc(a.id)}">Remove</button>
      </div>` : "";
  return `<div class="row-head">
      <div class="row-title">
        <div class="row-name">${title}<span class="row-email" title="${esc(subtitle)}">${esc(subtitle)}</span></div>
        <div class="row-actions">
          <button type="button" class="btn btn-ghost btn-icon" data-menu="${esc(a.id)}" aria-haspopup="menu" aria-expanded="${openMenuId === a.id}" aria-label="Options for ${esc(a.name)}">&#8943;</button>
          ${menu}
        </div>
      </div>
      <div class="row-summary">${rowSummary(v, now)}</div>
      ${signInAgain ? `<div>${signInAgain}</div>` : ""}
    </div>`;
}

function blockTitle(w, v, now) {
  const period = `${when(w.start, now)} - ${when(w.end, now)}`;
  switch (w.kind) {
    case "current": return `${v.account.name}, current window ${period}: ${pct(100 - w.usedPct)} left`;
    case "past": return `${v.account.name}, ${period}: peaked at ${pct(w.usedPct)}, ${pct(100 - w.usedPct)} unused`;
    case "planned": return `${v.account.name}, next window could start ${when(w.start, now)} and run to ${when(w.end, now)}`;
    case "partial": return `${v.account.name}, window from ${when(w.start, now)}: about ${pct(w.capacityPct)} of a session left in the weekly budget`;
    default: return `${v.account.name}, ${period}: locked or beyond the weekly budget`;
  }
}

/** Every usable bar says when it starts: in full when it fits, else the hour; the tooltip has the exact time. */
function startLabel(start, widthPx) {
  if (widthPx >= FULL_LABEL_PX) return `<span class="block-label">${clock(start)}</span>`;
  if (widthPx >= HOUR_LABEL_PX) return `<span class="block-label">${String(new Date(start).getHours()).padStart(2, "0")}</span>`;
  return "";
}

/** Day labels centered on the visible part of each day, with a line at each midnight. */
function axis(spanStart, spanEnd, now, x) {
  const labels = [];
  const lines = [];
  for (let day = startOfDay(spanStart); day < spanEnd; day += DAY) {
    const from = Math.max(day, spanStart);
    const to = Math.min(day + DAY, spanEnd);
    if (day > spanStart) lines.push(`<span class="gridline" style="left:${x(day)}%"></span>`);
    // A sliver of a day at the edge gets no label.
    if ((to - from) < 4 * HOUR) continue;
    const d = new Date(day);
    const isFirst = d.getDate() === 1;
    const dayName = day === startOfDay(now) ? "Today" : isFirst ? d.toLocaleDateString([], { month: "short" }) : d.toLocaleDateString([], { weekday: "short" });
    labels.push(`<div class="day ${day === startOfDay(now) ? "day-today" : ""}" style="left:${x(from)}%;width:${x(to) - x(from)}%">
        <span>${dayName}</span>
        <span class="num">${d.getDate()}</span>
      </div>`);
  }
  return { labels: labels.join(""), lines: lines.join("") };
}

function renderBoard(views, now, spanStart, spanEnd) {
  const span = spanEnd - spanStart;
  const x = (t) => ((Math.min(Math.max(t, spanStart), spanEnd) - spanStart) / span) * 100;
  // Measure the timeline to know which bars have room for their start time.
  const trackPx = document.querySelector(".track")?.clientWidth || document.querySelector(".axis")?.clientWidth || 900;
  const { labels, lines } = axis(spanStart, spanEnd, now, x);
  const nowLine = `<span class="now-line" style="left:${x(now)}%"></span>`;

  document.querySelector(".board")?.setAttribute("data-range", range);

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
        // Every usable bar says when it starts; locked bars stay quiet.
        const label = w.kind === "over" || w.start < spanStart ? "" : startLabel(w.start, (width / 100) * trackPx);
        return `<span class="block block-${w.kind}" style="left:${left}%;width:${width}%" title="${title}" aria-label="${title}" role="img">
          ${label}<span class="block-body"><span class="block-fill" style="height:${fill}%"></span></span>
        </span>`;
      }).join("");

    // All weekly resets in the span (supports multi-week in month view)
    const weeklyMarks = [];
    if (v.weekly?.resetsAt) {
      let r = v.weekly.resetsAt;
      while (r - 7 * DAY >= spanStart) r -= 7 * DAY;
      while (r <= spanEnd) {
        if (r >= spanStart) {
          weeklyMarks.push(`<span class="weekly-mark" style="left:${x(r)}%" title="Weekly reset ${esc(when(r, now))}"></span>`);
        }
        r += 7 * DAY;
      }
    }

    // Subscription renewal / ending markers
    const subMarks = (v.subscription?.markers || []).map((m) => {
      const markClass = m.type === "ends" ? "sub-mark sub-mark-ends" : "sub-mark";
      return `<span class="${markClass}" style="left:${x(m.at)}%" title="${esc(m.label)}">
        <span class="sub-mark-badge">${esc(m.label)}</span>
      </span>`;
    }).join("");

    return `${rowHead(v, now)}<div class="track">${lines}${blocks}${weeklyMarks.join("")}${subMarks}${nowLine}</div>`;
  }).join("");

  const empty = views.length ? "" : `<div class="empty">
      <h3>No accounts yet</h3>
      <p class="muted">Use <strong>Add account</strong> to add Claude or Antigravity.</p>
    </div>`;

  const focusKey = focusSelector(document.activeElement);
  $("board").innerHTML = `<div class="axis-spacer"></div><div class="axis">${labels}${nowLine}</div>${rows}${empty}`;
  // Redrawing replaces the elements, so put keyboard focus back on the same control.
  if (focusKey) document.querySelector(focusKey)?.focus();
}

/** A selector that finds the same control after a redraw, or null if it is not one of the board's. */
function focusSelector(el) {
  if (!el?.closest?.("#board")) return null;
  for (const attr of ["data-rename", "data-menu", "data-sign-in"]) {
    if (el.hasAttribute(attr)) return `[${attr}="${CSS.escape(el.getAttribute(attr))}"]`;
  }
  if (el.dataset.action) return `[data-action="${CSS.escape(el.dataset.action)}"][data-id="${CSS.escape(el.dataset.id)}"]`;
  return null;
}

function setRange(next) {
  range = next;
  try {
    localStorage.setItem(RANGE_KEY, next);
  } catch {
    // The choice just is not remembered.
  }
  for (const button of document.querySelectorAll("[data-range]")) {
    button.setAttribute("aria-checked", String(button.dataset.range === next));
  }
  render();
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
    loadError = null;
  } catch (err) {
    loadError = err.message;
  }
  // Do not redraw under the user while they type a new name or use a menu.
  if (state && !renamingId && !openMenuId) {
    try {
      render();
    } catch (err) {
      loadError = err.message;
      renderStatus(Date.now());
    }
  } else {
    renderStatus(Date.now());
  }
  clearTimeout(refreshTimer);
  const waiting = !$("connect").hidden || state?.signIn?.pending;
  refreshTimer = setTimeout(load, loadError ? 5_000 : waiting ? CONNECT_REFRESH_MS : REFRESH_MS);
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
$("meter-toggle").addEventListener("click", async () => {
  try {
    await api("POST", "/api/meter", { visible: !state.meter.visible });
    await load();
  } catch (err) {
    showToast(err.message, null);
  }
});
for (const button of document.querySelectorAll("[data-range]")) {
  button.addEventListener("click", () => setRange(button.dataset.range));
}
setRange(range);
for (const option of document.querySelectorAll("[data-provider]")) {
  option.addEventListener("click", () => selectProvider(option.dataset.provider));
}
$("connect-close").addEventListener("click", () => {
  toggleConnect(false);
  $("add-account").focus();
});
$("sign-in-claude").addEventListener("click", () => startSignIn("/api/accounts/claude/sign-in"));

/** Asks the desktop app to open a claude.ai sign-in window; the page then follows its progress. */
async function startSignIn(path) {
  try {
    await api("POST", path);
    await load();
  } catch (err) {
    showToast(err.message, null);
  }
}

$("open-ext-folder")?.addEventListener("click", async () => {
  try {
    await fetch("/api/extension/open-folder", { method: "POST" });
    showToast("Opened extension folder.", null);
  } catch {
    showToast("Could not open folder automatically.", null);
  }
});

$("copy-dir")?.addEventListener("click", async () => {
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
    if (item.dataset.action === "update-usage") {
      activeUsageAccountId = id;
      openUsageDialog(id);
    } else if (item.dataset.action === "rename") {
      renamingId = id;
      render();
      const input = document.querySelector(`[data-rename="${CSS.escape(id)}"]`);
      input?.focus();
      input?.select();
    } else if (item.dataset.action === "sign-in") {
      await startSignIn(`/api/accounts/${id}/sign-in`);
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
  const signInButton = event.target.closest("[data-sign-in]");
  if (signInButton) {
    await startSignIn(`/api/accounts/${signInButton.dataset.signIn}/sign-in`);
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

function openUsageDialog(id) {
  const account = state.accounts.find((a) => a.id === id);
  if (!account) return;
  const snapshot = [...state.snapshots].reverse().find((s) => s.accountId === id);
  const left = snapshot?.session?.usedPct !== undefined ? 100 - snapshot.session.usedPct : 100;
  const defaultHours = account.provider === "codex" ? 3 : 5;
  const resetsAt = snapshot?.session?.resetsAt;
  const remainingHours = resetsAt && resetsAt > Date.now()
    ? Math.max(0.5, Math.round(((resetsAt - Date.now()) / HOUR) * 2) / 2)
    : defaultHours;

  const planLabel = account.plan || state.providers[account.provider]?.plan || account.provider;
  $("usage-dialog-account").textContent = `${account.name} · ${account.email ? `${account.email} · ` : ""}${planLabel}`;
  $("usage-session-left").value = Math.round(left);
  $("usage-session-slider").value = Math.round(left);
  $("usage-duration").value = remainingHours;
  $("usage-weekly-used").value = snapshot?.weekly?.usedPct !== undefined ? Math.round(snapshot.weekly.usedPct) : "";

  const subType = account.subType || "monthly";
  if ($("usage-sub-type")) $("usage-sub-type").value = subType;
  if ($("usage-renews-day")) $("usage-renews-day").value = account.renewsDay || new Date(account.createdAt || Date.now()).getDate();
  if ($("usage-ends-at")) {
    $("usage-ends-at").value = account.endsAt ? new Date(account.endsAt).toISOString().split("T")[0] : "";
  }
  updateUsageSubFields(subType);

  $("usage-dialog")?.showModal();
}

function updateUsageSubFields(type) {
  if ($("usage-renews-day-row")) $("usage-renews-day-row").hidden = (type !== "monthly" && type !== "yearly");
  if ($("usage-ends-at-row")) $("usage-ends-at-row").hidden = (type !== "fixed");
}

$("usage-sub-type")?.addEventListener("change", (e) => {
  updateUsageSubFields(e.target.value);
});

$("usage-session-slider")?.addEventListener("input", (e) => {
  $("usage-session-left").value = e.target.value;
});
$("usage-session-left")?.addEventListener("input", (e) => {
  $("usage-session-slider").value = e.target.value;
});
$("usage-dialog-close")?.addEventListener("click", () => $("usage-dialog")?.close());
$("usage-cancel")?.addEventListener("click", () => $("usage-dialog")?.close());
$("usage-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!activeUsageAccountId) return;
  const sessionLeftPct = Number($("usage-session-left").value);
  const sessionDurationHours = Number($("usage-duration").value) || 3;
  const weeklyVal = $("usage-weekly-used").value.trim();
  const subType = $("usage-sub-type")?.value || "monthly";
  const payload = {
    sessionLeftPct,
    sessionDurationHours,
    subType,
  };
  if (weeklyVal !== "") payload.weeklyUsedPct = Number(weeklyVal);
  if (subType === "monthly" || subType === "yearly") {
    payload.renewsDay = Number($("usage-renews-day")?.value) || 1;
  } else if (subType === "fixed") {
    const dateVal = $("usage-ends-at")?.value;
    payload.endsAt = dateVal ? new Date(`${dateVal}T00:00:00`).getTime() : null;
  }
  try {
    await api("POST", `/api/accounts/${activeUsageAccountId}/reading`, payload);
    $("usage-dialog")?.close();
    await load();
    showToast("Usage & subscription updated.", null);
  } catch (err) {
    showToast(`Could not update usage: ${err.message}`, null);
  }
});

$("codex-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("codex-name").value.trim();
  const email = $("codex-email").value.trim() || null;
  const sessionDurationHours = Number($("codex-session-dur").value) || 3;
  const sessionLeftPct = Number($("codex-session-left").value);
  const statusEl = $("codex-status");
  statusEl.hidden = false;
  statusEl.textContent = "Adding account...";
  statusEl.classList.remove("connect-error", "connect-ok");
  try {
    await api("POST", "/api/accounts", {
      provider: "codex",
      name: name || undefined,
      email,
      sessionDurationHours,
      sessionLeftPct,
    });
    statusEl.textContent = "Account added!";
    statusEl.classList.add("connect-ok");
    $("codex-name").value = "";
    $("codex-email").value = "";
    await load();
    setTimeout(() => toggleConnect(false), 800);
  } catch (err) {
    statusEl.textContent = `Could not add account: ${err.message}`;
    statusEl.classList.add("connect-error");
  }
});

$("custom-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("custom-name").value.trim();
  const email = $("custom-email").value.trim() || null;
  const sessionDurationHours = Number($("custom-session-dur").value) || 5;
  const sessionLeftPct = Number($("custom-session-left").value);
  const statusEl = $("custom-status");
  statusEl.hidden = false;
  statusEl.textContent = "Adding account...";
  statusEl.classList.remove("connect-error", "connect-ok");
  try {
    await api("POST", "/api/accounts", {
      provider: "other",
      name: name || undefined,
      email,
      sessionDurationHours,
      sessionLeftPct,
    });
    statusEl.textContent = "Account added!";
    statusEl.classList.add("connect-ok");
    $("custom-name").value = "";
    $("custom-email").value = "";
    await load();
    setTimeout(() => toggleConnect(false), 800);
  } catch (err) {
    statusEl.textContent = `Could not add account: ${err.message}`;
    statusEl.classList.add("connect-error");
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
// Keep the "now" line and countdowns moving between data refreshes.
setInterval(() => !renamingId && !openMenuId && render(), REFRESH_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") load();
});
