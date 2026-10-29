// The floating meter: two rings per account, the 5-hour session outside and the week inside.
// Runs in a small always-on-top window (app/meter.js); `window.aiMeter` comes from its preload.
import { badgeFor, initials } from "./badge.js";
import { accountView, DAY } from "./model.js";

const REFRESH_MS = 30_000;
const PROVIDER_ORDER = { claude: 0, antigravity: 1 };
// Ring geometry in a 28x28 view box, 3px strokes with a 2px gap between the rings.
const OUTER = 11.5;
const INNER = 6.5;

// Outside the desktop app (opened in a normal browser) the bridge is missing; the meter still renders.
const bridge = window.aiMeter ?? {
  setInteractive() {},
  open() {},
  menu() {},
  setHeight() {},
  hidden: async () => [],
  onHiddenChanged() {},
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
let state = null;
let hidden = new Set();
let badges = [];

/** One ring: a track, and an arc for what is left. A level that is not reported gets a dashed track. */
function ring(kind, radius, level) {
  const circumference = 2 * Math.PI * radius;
  const dash = ((level.leftPct ?? 0) / 100) * circumference;
  const track = `<circle class="ring-track ${level.leftPct === null ? "unknown" : ""}" cx="14" cy="14" r="${radius}"/>`;
  const fill = dash > 0
    ? `<circle class="ring-fill ring-${kind} tone-${level.tone}" cx="14" cy="14" r="${radius}" stroke-dasharray="${dash} ${circumference}"/>`
    : "";
  return track + fill;
}

function render() {
  if (!state) return;
  const now = Date.now();
  const accounts = state.accounts
    .filter((a) => !hidden.has(a.id))
    .sort((a, b) => (PROVIDER_ORDER[a.provider] ?? 9) - (PROVIDER_ORDER[b.provider] ?? 9) || a.createdAt - b.createdAt);
  badges = accounts.map((a) => badgeFor(accountView(a, state.snapshots, now, now, now + DAY), state.status[a.id], state.seen[a.id], now));

  $("rings").innerHTML = badges.map((b, i) => `<button type="button" class="ring state-${b.state}" data-index="${i}" aria-label="${esc([b.name, ...b.lines].join(". "))}">
        <svg class="ring-svg" viewBox="0 0 28 28" aria-hidden="true">${ring("session", OUTER, b.session)}${ring("week", INNER, b.week)}</svg>
        <span class="ring-label">${esc(initials(b.name))}</span>
      </button>`).join("");
  // The window hugs the pill so the meter takes no more of the screen edge than it needs.
  bridge.setHeight(Math.ceil($("pill").getBoundingClientRect().height) + 8);
}

function showCard(el) {
  const b = badges[Number(el.dataset.index)];
  if (!b) return;
  // The colored circle before each line matches its ring: session outside, week inside.
  const keys = b.state === "ok" ? ["key-session", "key-week"] : ["key-none", "key-none"];
  $("card").innerHTML = `<p class="card-name">${esc(b.name)}</p>${b.lines.map((line, i) => `<p class="card-line ${keys[i]}">${esc(line)}</p>`).join("")}`;
  $("card").hidden = false;
  const r = el.getBoundingClientRect();
  const card = $("card").getBoundingClientRect();
  $("card").style.top = `${Math.max(0, r.top + 14 - card.height / 2)}px`;
}

async function load() {
  try {
    const res = await fetch("/api/state");
    if (res.ok) state = await res.json();
  } catch {
    // The app is restarting; keep the last reading on screen.
  }
  render();
}

// Clicks pass through the transparent part of the window; only the pill and its card take the mouse.
document.addEventListener("mousemove", (event) => {
  bridge.setInteractive(Boolean(event.target.closest?.(".pill")));
});
document.addEventListener("mouseleave", () => {
  bridge.setInteractive(false);
  $("card").hidden = true;
});

$("rings").addEventListener("mouseover", (event) => {
  const ring = event.target.closest(".ring");
  if (ring) showCard(ring);
});
$("rings").addEventListener("mouseout", (event) => {
  if (!event.relatedTarget?.closest?.(".ring")) $("card").hidden = true;
});
$("rings").addEventListener("focusin", (event) => {
  const ring = event.target.closest(".ring");
  if (ring) showCard(ring);
});
$("rings").addEventListener("focusout", () => {
  $("card").hidden = true;
});
$("rings").addEventListener("click", (event) => {
  if (event.target.closest(".ring")) bridge.open();
});
document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  bridge.menu();
});

bridge.onHiddenChanged((ids) => {
  hidden = new Set(ids);
  render();
});
hidden = new Set(await bridge.hidden());
load();
setInterval(load, REFRESH_MS);
