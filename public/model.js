// Pure usage model shared by the browser and the tests. No DOM, no I/O.
//
// A snapshot is one observation of an account's limits:
//   { accountId, at, session: { usedPct, resetsAt } | null, weekly: { usedPct, resetsAt } | null, source }
// All times are epoch milliseconds.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const SESSION_MS = 5 * HOUR;

// Reset timestamps from the same window can differ slightly between observations.
const RESET_TOLERANCE_MS = 5 * MINUTE;
// A session at or above this is treated as used up when suggesting where to work next.
export const NEAR_FULL_PCT = 95;
// Session-percent points that must be observed before the weekly budget is trusted.
export const MIN_CALIBRATION_PCT = 50;
// How far back the burn rate looks.
const BURN_LOOKBACK_MS = HOUR;
const MIN_BURN_SPAN_MS = 5 * MINUTE;
// A session counts as "active" for the projection if it was observed this recently.
const ACTIVE_WITHIN_MS = 30 * MINUTE;

/** Groups session observations into windows. Windows of one account never overlap, so samples are contiguous. */
export function groupSessions(snapshots) {
  const groups = [];
  for (const snap of snapshots) {
    if (!snap.session) continue;
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.resetsAt - snap.session.resetsAt) <= RESET_TOLERANCE_MS) {
      last.samples.push(snap);
      last.resetsAt = snap.session.resetsAt;
    } else {
      groups.push({ resetsAt: snap.session.resetsAt, samples: [snap] });
    }
  }
  return groups.map((g) => ({
    resetsAt: g.resetsAt,
    start: g.resetsAt - SESSION_MS,
    samples: g.samples,
    peakPct: Math.max(...g.samples.map((s) => s.session.usedPct)),
  }));
}

/**
 * Session-percent consumed per hour in a window, or null when there is not enough signal.
 * `anchored` means the window is known to start at 0% exactly SESSION_MS before its reset (Claude).
 */
export function burnPerHour(group, anchored) {
  const samples = group.samples;
  const last = samples[samples.length - 1];
  const recent = samples.filter((s) => s.at >= last.at - BURN_LOOKBACK_MS);
  const first = recent[0];
  const span = last.at - first.at;
  const delta = last.session.usedPct - first.session.usedPct;
  if (span >= MIN_BURN_SPAN_MS && delta > 0) return (delta / span) * HOUR;
  if (anchored && last.session.usedPct > 0 && last.at > group.start) {
    return (last.session.usedPct / (last.at - group.start)) * HOUR;
  }
  return null;
}

/**
 * Learns how much of the weekly cap one full session costs, from windows where both
 * the session and the weekly percentage were observed moving together.
 */
export function calibrate(snapshots) {
  const paired = snapshots.filter((s) => s.session && s.weekly);
  let sessionPts = 0;
  let weeklyPts = 0;
  for (const group of groupSessions(paired)) {
    const first = group.samples[0];
    const last = group.samples[group.samples.length - 1];
    if (Math.abs(first.weekly.resetsAt - last.weekly.resetsAt) > RESET_TOLERANCE_MS) continue;
    const dSession = last.session.usedPct - first.session.usedPct;
    const dWeekly = last.weekly.usedPct - first.weekly.usedPct;
    if (dSession <= 0 || dWeekly < 0) continue;
    sessionPts += dSession;
    weeklyPts += dWeekly;
  }
  if (sessionPts < MIN_CALIBRATION_PCT || weeklyPts <= 0) {
    return { ready: false, observedSessionPct: sessionPts };
  }
  const weeklyPctPerSession = (weeklyPts / sessionPts) * 100;
  return {
    ready: true,
    observedSessionPct: sessionPts,
    weeklyPctPerSession,
    sessionsPerWeek: 100 / weeklyPctPerSession,
  };
}

/** Everything the dashboard shows for one account at time `now`, over the timeline [spanStart, spanEnd). */
export function accountView(account, allSnapshots, now, spanStart, spanEnd) {
  const snapshots = allSnapshots
    .filter((s) => s.accountId === account.id && s.at <= now)
    .sort((a, b) => a.at - b.at);
  // Claude windows start at the first message, so a window always began exactly 5 hours before its reset.
  const anchored = account.provider === "claude";
  const groups = groupSessions(snapshots);
  const lastGroup = groups[groups.length - 1];
  const currentGroup = lastGroup && lastGroup.resetsAt > now ? lastGroup : null;

  let session;
  if (currentGroup) {
    const lastSample = currentGroup.samples[currentGroup.samples.length - 1];
    const usedPct = lastSample.session.usedPct;
    const rate = burnPerHour(currentGroup, anchored);
    let projectedFullAt = null;
    if (rate && usedPct < 100) {
      const at = lastSample.at + ((100 - usedPct) / rate) * HOUR;
      if (at < currentGroup.resetsAt) projectedFullAt = Math.max(at, now);
    }
    session = {
      state: "open",
      usedPct,
      resetsAt: currentGroup.resetsAt,
      lastSeenAt: lastSample.at,
      burnPerHour: rate,
      projectedFullAt,
    };
  } else {
    session = { state: "idle", lastResetAt: lastGroup ? lastGroup.resetsAt : null };
  }

  const lastWeekly = [...snapshots].reverse().find((s) => s.weekly);
  let weekly = null;
  if (lastWeekly?.weekly.resetsAt > now) {
    weekly = { usedPct: lastWeekly.weekly.usedPct, resetsAt: lastWeekly.weekly.resetsAt, seenAt: lastWeekly.at };
  } else if (lastWeekly && anchored) {
    // Claude always reports a weekly window, so a passed reset means a new week has begun.
    weekly = { usedPct: 0, resetsAt: null, seenAt: lastWeekly.at };
  }

  // Antigravity Flash models have their own quota; shown as a secondary bar only.
  const lastFlash = [...snapshots].reverse().find((s) => s.flash !== undefined)?.flash;
  const flash = lastFlash && lastFlash.resetsAt > now ? lastFlash : null;
  const exhausted = Boolean(weekly && weekly.usedPct >= 100);

  const calibration = calibrate(snapshots);
  const sessionsLeft = calibration.ready && weekly
    ? Math.max(0, (100 - weekly.usedPct) / calibration.weeklyPctPerSession)
    : null;

  const windows = groups
    .filter((g) => g.resetsAt > spanStart && g.start < spanEnd)
    .map((g) => ({
      start: g.start,
      end: g.resetsAt,
      usedPct: g === currentGroup ? session.usedPct : g.peakPct,
      kind: g === currentGroup ? "current" : "past",
    }));
  windows.push(...planWindows({ session, weekly, exhausted, calibration, sessionsLeft, now, spanEnd }));

  return { account, session, weekly, exhausted, flash, calibration, sessionsLeft, windows, lastSeenAt: snapshots.at(-1)?.at ?? null };
}

/**
 * Back-to-back future windows from the end of the current one to the end of the timeline.
 * Windows the weekly budget cannot cover are marked "over".
 */
function planWindows({ session, weekly, exhausted, calibration, sessionsLeft, now, spanEnd }) {
  const currentRemaining = session.state === "open" ? (100 - session.usedPct) / 100 : 0;
  let budget;
  if (sessionsLeft !== null) budget = sessionsLeft - currentRemaining;
  else budget = exhausted ? 0 : Infinity;

  const planned = [];
  let refilled = false;
  let cursor = session.state === "open" ? session.resetsAt : now;
  // A lockout is one locked stretch, and the next window can start the moment it lifts.
  if (exhausted && weekly?.resetsAt > cursor) {
    planned.push({ start: cursor, end: weekly.resetsAt, capacityPct: 0, kind: "over" });
    cursor = weekly.resetsAt;
  }
  for (; cursor < spanEnd; cursor += SESSION_MS) {
    if (!refilled && weekly?.resetsAt && cursor >= weekly.resetsAt) {
      budget = calibration.ready ? calibration.sessionsPerWeek : Infinity;
      refilled = true;
    }
    const capacity = Math.max(0, Math.min(1, budget));
    planned.push({
      start: cursor,
      end: cursor + SESSION_MS,
      capacityPct: capacity * 100,
      kind: capacity >= 1 ? "planned" : capacity > 0 ? "partial" : "over",
    });
    budget -= 1;
  }
  return planned;
}

/** When an account can next be used, or null if it is usable now. */
export function availableAt(view, now) {
  if (view.exhausted) return view.weekly.resetsAt;
  if (view.session.state === "open" && view.session.usedPct >= NEAR_FULL_PCT) return view.session.resetsAt;
  return now;
}

/** The planner strip: totals, where to work next, and the active session's projection. */
export function summarize(views, now) {
  const known = views.filter((v) => v.sessionsLeft !== null);
  const sessionsLeft = {
    total: known.reduce((sum, v) => sum + v.sessionsLeft, 0),
    known: known.length,
    unknown: views.filter((v) => v.sessionsLeft === null).map((v) => v.account.name),
  };

  // Open windows with capacity left expire unused, so they come first, soonest reset first.
  const usableOpen = views
    .filter((v) => v.session.state === "open" && availableAt(v, now) === now)
    .sort((a, b) => a.session.resetsAt - b.session.resetsAt);
  const idleReady = views.filter((v) => v.session.state === "idle" && !v.exhausted);

  let suggestion;
  if (usableOpen.length) {
    const v = usableOpen[0];
    suggestion = { view: v, at: now, kind: "use-open", remainingPct: 100 - v.session.usedPct, until: v.session.resetsAt };
  } else if (idleReady.length) {
    const v = [...idleReady].sort((a, b) => (b.sessionsLeft ?? Infinity) - (a.sessionsLeft ?? Infinity))[0];
    suggestion = { view: v, at: now, kind: "start-fresh", until: now + SESSION_MS };
  } else if (views.length) {
    const v = [...views].sort((a, b) => availableAt(a, now) - availableAt(b, now))[0];
    suggestion = { view: v, at: availableAt(v, now), kind: v.exhausted ? "weekly-wait" : "session-wait" };
  } else {
    suggestion = null;
  }

  // A single fresh reading is not evidence of use, so the active session needs a measured burn rate.
  const active = views
    .filter((v) => v.session.state === "open" && v.session.burnPerHour && now - v.session.lastSeenAt <= ACTIVE_WITHIN_MS)
    .sort((a, b) => b.session.lastSeenAt - a.session.lastSeenAt)[0] ?? null;

  const open = views.filter((v) => v.session.state === "open").sort((a, b) => a.session.resetsAt - b.session.resetsAt);

  return {
    sessionsLeft,
    suggestion,
    active,
    nextReset: open[0] ?? null,
    readyCount: views.filter((v) => availableAt(v, now) === now).length,
  };
}
