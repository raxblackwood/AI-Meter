// The floating meter: one ring per account with what is left in its current window.
// Runs in a small always-on-top window (app/meter.js); `window.aiMeter` comes from its preload.
import { badgeFor, initials } from "./badge.js";
import { accountView, DAY } from "./model.js";

const REFRESH_MS = 30_000;
const PROVIDER_ORDER = { claude: 0, antigravity: 1 };
const RADIUS = 16;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const LOCK = `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5 7V5a3 3 0 0 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7H5Zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2Z"/></svg>`;

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

function render() {
  if (!state) return;
  const now = Date.now();
  const accounts = state.accounts
    .filter((a) => !hidden.has(a.id))
    .sort((a, b) => (PROVIDER_ORDER[a.provider] ?? 9) - (PROVIDER_ORDER[b.provider] ?? 9) || a.createdAt - b.createdAt);
  badges = accounts.map((a) => badgeFor(accountView(a, state.snapshots, now, now, now + DAY), state.status[a.id], state.seen[a.id]));

  $("rings").innerHTML = badges.map((b, i) => {
    const dash = (b.fillPct / 100) * CIRCUMFERENCE;
    const value = b.glyph === "lock" ? LOCK : esc(b.text);
    const label = [b.name, b.line, b.detail].filter(Boolean).join(". ");
    return `<button type="button" class="ring tone-${b.tone}" data-index="${i}" aria-label="${esc(label)}">
        <svg class="ring-svg" viewBox="0 0 40 40" aria-hidden="true">
          <circle class="ring-track" cx="20" cy="20" r="${RADIUS}"/>
          ${dash > 0 ? `<circle class="ring-fill" cx="20" cy="20" r="${RADIUS}" stroke-dasharray="${dash} ${CIRCUMFERENCE}"/>` : ""}
        </svg>
        <span class="ring-value">${value}</span>
        <span class="ring-label">${esc(initials(b.name))}</span>
      </button>`;
  }).join("");
  // The window hugs the pill so the meter takes no more of the screen edge than it needs.
  bridge.setHeight(Math.ceil($("pill").getBoundingClientRect().height) + 12);
}

function showCard(ring) {
  const b = badges[Number(ring.dataset.index)];
  if (!b) return;
  $("card-name").textContent = b.name;
  $("card-line").textContent = b.line;
  $("card-detail").textContent = b.detail ?? "";
  $("card").hidden = false;
  const r = ring.getBoundingClientRect();
  const card = $("card").getBoundingClientRect();
  $("card").style.top = `${Math.max(0, r.top + 20 - card.height / 2)}px`;
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
