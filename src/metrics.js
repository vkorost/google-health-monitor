// Derived numbers and the alert state machine. PURE: plain objects in, plain
// objects out. Everything here runs under `node --test` with no D1 and no
// network, the same discipline as detect.js in the Nest project.

import { BUCKET_S, DAY_S, addDays, localParts } from "./ingest.js";

// Calendar dates as integer day numbers for the hot loops below: string date
// arithmetic allocates a Date per step, and the "all" range walks ~3,000 days
// several times inside a 10 ms CPU budget.
const DAY_MS = 86400000;
export const dayNum = (date) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / DAY_MS;
const dateCache = new Map();
export function dateOf(n) {
  let s = dateCache.get(n);
  if (!s) { s = new Date(n * DAY_MS).toISOString().slice(0, 10); dateCache.set(n, s); }
  return s;
}

const round1 = (v) => Math.round(v * 10) / 10;

// ------------------------------------------------------------ sleep

/** For each wake_date keep the longest session: naps must not replace the night. */
export function mainNights(nights) {
  const best = new Map();
  for (const n of nights) {
    const cur = best.get(n.wake_date);
    if (!cur || n.end_ts - n.start_ts > cur.end_ts - cur.start_ts) best.set(n.wake_date, n);
  }
  return best;
}

// ------------------------------------------------------------ heart

/**
 * Resting heart rate: the lowest 30-minute average while asleep, taken as the
 * mean of two consecutive 15-minute bucket averages inside the night.
 * A missing bucket breaks the pair rather than bridging it, so a gap in the
 * watch data can never manufacture a low value out of two distant readings.
 */
export function restingHr(buckets, startS, endS) {
  const inside = buckets
    .filter((b) => b.start_ts >= startS && b.start_ts + BUCKET_S <= endS + BUCKET_S / 2)
    .sort((a, b) => a.start_ts - b.start_ts);
  let best = null;
  for (let i = 1; i < inside.length; i++) {
    if (inside[i].start_ts - inside[i - 1].start_ts !== BUCKET_S) continue;
    const v = (inside[i].avg + inside[i - 1].avg) / 2;
    if (best === null || v < best) best = v;
  }
  return best === null ? null : round1(best);
}

/** rhr_daily rows for every wake_date that has a main night and enough buckets. */
export function restingHrRows(nights, buckets) {
  const rows = [];
  for (const [date, n] of mainNights(nights)) {
    const bpm = restingHr(buckets, n.start_ts, n.end_ts);
    if (bpm !== null) rows.push({ date, bpm, night_id: n.id });
  }
  return rows;
}

// ------------------------------------------------------------ body

/**
 * Drop repeat writes of the same reading. Observed in production: one weigh-in
 * stored twice, 38 seconds apart, identical value.
 */
export function dedupeBody(readings, windowS = 120) {
  const sorted = readings.slice().sort((a, b) => a.ts - b.ts);
  const out = [];
  const lastByKind = new Map();
  for (const r of sorted) {
    const prev = lastByKind.get(r.kind);
    if (prev && r.ts - prev.ts <= windowS && Math.abs(r.value - prev.value) < 1e-6) continue;
    out.push(r);
    lastByKind.set(r.kind, r);
  }
  return out;
}

const median = (arr) => {
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Adds `median` to each reading: median of same-kind values in (ts - days, ts]. */
export function rollingMedian(readings, days = 7) {
  const sorted = readings.slice().sort((a, b) => a.ts - b.ts);
  let lo = 0;
  return sorted.map((r, i) => {
    while (sorted[lo].ts <= r.ts - days * DAY_S) lo++;
    return { ...r, median: median(sorted.slice(lo, i + 1).map((x) => x.value)) };
  });
}

/** Contiguous runs of the same source, for scale-change bands on the charts. */
export function sourceEras(readings) {
  const eras = [];
  for (const r of readings.slice().sort((a, b) => a.ts - b.ts)) {
    const last = eras[eras.length - 1];
    if (last && last.source === r.source) last.to = r.ts;
    else eras.push({ source: r.source, from: r.ts, to: r.ts });
  }
  return eras;
}

// ------------------------------------------------------------ trends

export const RANGES = { "1w": 7, "1m": 30, "3m": 91, "1y": 365 };

/** Resolve a range key to { from, to, grain } in local dates. */
export function rangeSpec(range, today, earliest) {
  const days = RANGES[range];
  const from = days ? addDays(today, -days + 1) : earliest || addDays(today, -365);
  const grain = range === "1y" ? "week" : range === "all" ? "month" : "day";
  return { from, to: today, grain };
}

/** Every period between from and to, oldest first, with its date span. */
export function periods(from, to, grain) {
  const out = [];
  if (grain === "day") {
    for (let d = dayNum(from), end = dayNum(to); d <= end; d++) { const s = dateOf(d); out.push({ key: s, a: s, b: s }); }
  } else if (grain === "week") {
    for (let end = to; end >= from; end = addDays(end, -7)) {
      const a = addDays(end, -6);
      out.unshift({ key: end, a: a < from ? from : a, b: end });
    }
  } else {
    let [y, m] = from.split("-").map(Number);
    for (;;) {
      const a = `${y}-${String(m).padStart(2, "0")}-01`;
      if (a > to) break;
      const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
      const b = addDays(next, -1);
      out.push({ key: a.slice(0, 7), a: a < from ? from : a, b: b > to ? to : b });
      m++; if (m > 12) { m = 1; y++; }
    }
  }
  return out;
}

/**
 * Average per-night stage minutes per period. Input: main nights keyed by
 * wake_date. Output aligned with periods(); v is null where no night exists.
 */
export function sleepSeries(nightsByDate, from, to, grain) {
  return periods(from, to, grain).map((p) => {
    const acc = { deep: 0, rem: 0, light: 0, awake: 0, asleep: 0 };
    let n = 0;
    for (let d = dayNum(p.a), end = dayNum(p.b); d <= end; d++) {
      const x = nightsByDate.get(dateOf(d));
      if (!x) continue;
      n++;
      acc.deep += x.deep_min; acc.rem += x.rem_min; acc.light += x.light_min;
      acc.awake += x.awake_min; acc.asleep += x.asleep_min;
    }
    const v = n
      ? Object.fromEntries(Object.entries(acc).map(([k, s]) => [k, round1(s / n)]))
      : null;
    return { ...p, n, v };
  });
}

/** Daily values averaged per period: [{key,a,b,n,value}] (value null when empty). */
export function averageSeries(dailyMap, from, to, grain) {
  return periods(from, to, grain).map((p) => {
    let s = 0, n = 0;
    for (let d = dayNum(p.a), end = dayNum(p.b); d <= end; d++) {
      const v = dailyMap.get(dateOf(d));
      if (v !== undefined && v !== null) { s += v; n++; }
    }
    return { ...p, n, value: n ? round1(s / n) : null };
  });
}

/** Trailing N-day mean at each date (dates with no value in the window get null). */
export function trailingMean(dailyMap, dates, days = 30) {
  return dates.map((date) => {
    let s = 0, n = 0;
    const end = dayNum(date);
    for (let d = end - days + 1; d <= end; d++) {
      const v = dailyMap.get(dateOf(d));
      if (v !== undefined && v !== null) { s += v; n++; }
    }
    return { date, value: n ? round1(s / n) : null };
  });
}

/** Exercise minutes per category per period. workouts carry local `date` and `category`. */
export function exerciseSeries(workouts, from, to, grain) {
  const byDate = new Map();
  for (const w of workouts) {
    const list = byDate.get(w.date) || [];
    list.push(w);
    byDate.set(w.date, list);
  }
  return periods(from, to, grain).map((p) => {
    const v = { Swimming: 0, Biking: 0, Other: 0 };
    for (let d = dayNum(p.a), end = dayNum(p.b); d <= end; d++) {
      for (const w of byDate.get(dateOf(d)) || []) v[w.category] += w.minutes;
    }
    for (const k in v) v[k] = Math.round(v[k]);
    return { ...p, v };
  });
}

// Chest strap beats the watch: a Polar H10 session recorded with Polar Beat is one
// continuous, more accurate record of the same ride Samsung split at every stop.
const WORKOUT_SOURCE_RANK = { "fi.polar.polarflow": 3, "com.sec.android.app.shealth": 2 };

/**
 * Drop workouts that duplicate a better source's workout of the same category.
 * Two workouts are the same activity when they overlap by at least half of the
 * shorter one. Stored rows stay untouched; this runs at read time.
 */
export function dropDuplicateWorkouts(workouts) {
  const rank = (w) => WORKOUT_SOURCE_RANK[w.source] || 1;
  const ordered = [...workouts].sort((a, b) => rank(b) - rank(a) || (b.end_ts - b.start_ts) - (a.end_ts - a.start_ts));
  const kept = [];
  for (const w of ordered) {
    const dup = kept.some((k) => k.category === w.category && k.source !== w.source &&
      Math.min(k.end_ts, w.end_ts) - Math.max(k.start_ts, w.start_ts) >= 0.5 * Math.min(k.end_ts - k.start_ts, w.end_ts - w.start_ts));
    if (!dup) kept.push(w);
  }
  return kept.sort((a, b) => a.start_ts - b.start_ts);
}

/**
 * Join workouts of the same category that follow each other within `gapS`.
 * Samsung auto-pause splits one ride into a new session at every traffic
 * light, although it is one ride. Stored rows stay untouched so
 * the rule can change later. Input sorted or not; output sorted by start.
 */
export function mergeWorkouts(workouts, gapS = 600) {
  const sorted = [...workouts].sort((a, b) => a.start_ts - b.start_ts);
  const out = [];
  for (const w of sorted) {
    const active = w.active_s != null ? w.active_s : w.end_ts - w.start_ts;
    const prev = out[out.length - 1];
    if (prev && prev.category === w.category && w.start_ts - prev.end_ts <= gapS) {
      // average heart rate weighted by moving time, so a 5-minute segment does not count like a 30-minute one
      const hrWeight = (prev._hrw || 0) + (w.avg_hr != null ? active : 0);
      if (w.avg_hr != null) prev._hrs = (prev._hrs || 0) + w.avg_hr * active;
      prev._hrw = hrWeight;
      prev.avg_hr = hrWeight ? prev._hrs / hrWeight : null;
      prev.max_hr = [prev.max_hr, w.max_hr].filter((x) => x != null).reduce((a, b) => Math.max(a, b), -Infinity);
      if (prev.max_hr === -Infinity) prev.max_hr = null;
      prev.end_ts = Math.max(prev.end_ts, w.end_ts);
      prev.active_s += active;
      prev.parts += 1;
    } else {
      out.push({ ...w, active_s: active, parts: 1,
        _hrs: w.avg_hr != null ? w.avg_hr * active : 0, _hrw: w.avg_hr != null ? active : 0 });
    }
  }
  return out.map(({ _hrs, _hrw, ...w }) => ({ ...w, avg_hr: w.avg_hr == null ? null : Math.round(w.avg_hr * 10) / 10 }));
}

// ------------------------------------------------------------ sleep score

/*
 * Our own 0-100 sleep score using the factors Samsung names for its score
 * (total sleep, sleep cycles, awakenings, deep = physical recovery, REM =
 * mental recovery) plus efficiency. Samsung does not publish its formula, so
 * the curves and weights below are common-sense sleep-science anchors,
 * calibrated against one night the user's Samsung app rated Excellent.
 * Re-tune against your own Samsung export when one is available.
 */
export const SLEEP_BANDS = [
  // On the development account's ~730 Samsung-era nights these cutoffs gave
  // roughly a third Excellent, two fifths Good, a sixth Fair and the rest Attention.
  { min: 88, label: "Excellent" },
  { min: 75, label: "Good" },
  { min: 55, label: "Fair" },
  { min: 0, label: "Attention" },
];

// piecewise-linear: points [[x, score], ...] sorted by x, clamped at both ends
function curve(x, points) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i], [x0, y0] = points[i - 1];
    if (x <= x1) return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }
  return points[points.length - 1][1];
}

const SCORE_WEIGHTS = { duration: 30, efficiency: 15, deep: 15, rem: 15, awakenings: 15, cycles: 10 };

/** stages: compact [[offsetMin, lenMin, code]]. Returns null for nights without stage detail. */
export function sleepScore(stages, inBedMin) {
  if (!stages || !stages.length || !(inBedMin > 0)) return null;
  const t = { d: 0, r: 0, l: 0, a: 0, s: 0 };
  for (const [, len, c] of stages) t[c] = (t[c] || 0) + len;
  const asleep = t.d + t.r + t.l + t.s;
  if (asleep < 60) return null;

  // Awake time only counts after the first sleep and before the last; lying awake before
  // sleep onset is latency, which efficiency already penalises.
  const firstSleep = stages.findIndex((s) => s[2] !== "a");
  let lastSleep = stages.length - 1;
  while (lastSleep > 0 && stages[lastSleep][2] === "a") lastSleep--;
  let waso = 0, wakeups = 0;
  for (let i = firstSleep; i <= lastSleep; i++) {
    if (stages[i][2] === "a") { waso += stages[i][1]; if (stages[i][1] >= 3) wakeups++; }
  }
  // A cycle ends with a REM episode; REM blocks less than 20 minutes apart are one episode.
  let cycles = 0, lastRemEnd = -Infinity;
  for (const [off, len, c] of stages) {
    if (c !== "r") continue;
    if (off - lastRemEnd >= 20) cycles++;
    lastRemEnd = off + len;
  }

  const h = asleep / 60;
  const parts = {
    duration: curve(h, [[4, 0], [6, 60], [7, 95], [7.5, 100], [9, 100], [10.5, 75]]),
    efficiency: curve(asleep / inBedMin, [[0.7, 0], [0.8, 50], [0.88, 85], [0.93, 100]]),
    deep: curve(t.d / asleep, [[0.05, 10], [0.1, 60], [0.15, 90], [0.18, 100]]),
    rem: curve(t.r / asleep, [[0.08, 10], [0.14, 60], [0.19, 90], [0.22, 100]]),
    awakenings: Math.min(curve(waso, [[20, 100], [45, 85], [90, 50], [150, 0]]), curve(wakeups, [[3, 100], [6, 70], [12, 20]])),
    cycles: curve(cycles, [[1, 20], [2, 55], [3, 80], [4, 100]]),
  };
  let total = 0;
  for (const k in SCORE_WEIGHTS) total += parts[k] * SCORE_WEIGHTS[k] / 100;
  // Short sleep caps the score: a well-structured 4-hour night is still not a good night.
  const score = Math.round(Math.min(total, 40 + parts.duration * 0.6));
  return {
    score,
    label: SLEEP_BANDS.find((b) => score >= b.min).label,
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v)])),
    facts: { asleep_min: Math.round(asleep), efficiency: Math.round(asleep / inBedMin * 100), deep_pct: Math.round(t.d / asleep * 100),
      rem_pct: Math.round(t.r / asleep * 100), waso_min: Math.round(waso), wakeups, cycles },
  };
}

// ------------------------------------------------------------ alerts

export const ALERT_TYPES = ["stale", "failing", "auth"];

export const DEFAULT_SETTINGS = {
  alert_stale: true,
  stale_days: 2,
  alert_failing: true,
  failing_runs: 2,
  alert_recover: true,
  quiet_enabled: true,
  quiet_start: "22:00",
  quiet_end: "08:00",
};

export function normaliseSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  const int = (v, lo, hi, dflt) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  s.stale_days = int(s.stale_days, 1, 14, DEFAULT_SETTINGS.stale_days);
  s.failing_runs = int(s.failing_runs, 1, 7, DEFAULT_SETTINGS.failing_runs);
  for (const k of ["alert_stale", "alert_failing", "alert_recover", "quiet_enabled"]) s[k] = Boolean(s[k]);
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!hhmm.test(s.quiet_start)) s.quiet_start = DEFAULT_SETTINGS.quiet_start;
  if (!hhmm.test(s.quiet_end)) s.quiet_end = DEFAULT_SETTINGS.quiet_end;
  return s;
}

export function inQuietHours(settings, nowS, tz) {
  if (!settings.quiet_enabled) return false;
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const start = toMin(settings.quiet_start), end = toMin(settings.quiet_end);
  const m = localParts(nowS, tz).minutes;
  if (start === end) return false;
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/**
 * Which pipeline problems exist right now.
 * lastDataS: newest of (last heart-rate bucket end, last night end). Watch data
 * counts as stopped only when neither has arrived for stale_days.
 */
export function evaluateConditions({ nowS, lastDataS, consecutiveFailures, authFailed, settings }) {
  const staleS = lastDataS ? nowS - lastDataS : Infinity;
  return {
    stale: { active: settings.alert_stale && staleS > settings.stale_days * DAY_S,
             payload: { days: lastDataS ? Math.floor(staleS / DAY_S) : null } },
    failing: { active: settings.alert_failing && !authFailed && consecutiveFailures >= settings.failing_runs,
               payload: { runs: consecutiveFailures } },
    // Always on: a monitor that has lost access goes blind silently otherwise.
    auth: { active: Boolean(authFailed), payload: {} },
  };
}

export function message(type, direction, payload = {}) {
  if (type === "stale") {
    return direction === "fire"
      ? { title: "Health Monitor: watch data stopped",
          body: `No new heart rate or sleep for ${payload.days ?? "several"} days. Open Samsung Health on the phone, then Google Health, to restart sync.` }
      : { title: "Health Monitor: watch data is flowing again",
          body: payload.backfilled ? `Data resumed; ${payload.backfilled} missing days were backfilled.` : "Data resumed." };
  }
  if (type === "failing") {
    return direction === "fire"
      ? { title: "Health Monitor: daily pull failing", body: `The pull has failed ${payload.runs} times in a row. Check the sync log on the dashboard.` }
      : { title: "Health Monitor: daily pull working again", body: "The last pull finished without errors." };
  }
  return direction === "fire"
    ? { title: "Health Monitor: Google access lost", body: "Google rejected the saved sign-in. Sign in again and update GOOGLE_REFRESH_TOKEN, or no new data will arrive." }
    : { title: "Health Monitor: Google access restored", body: "The saved sign-in works again." };
}

/**
 * Advance alert state. Recording and delivery are separate on purpose: the
 * alert row is written whatever the push service is doing, and only delivery
 * is retried on a later run (Nest lesson: a failed push must not erase evidence).
 *
 * state per type: { active, fired, pending, recover_pending, since_ts }
 *   pending          fire recorded, not yet delivered (quiet hours or push failure)
 *   recover_pending  recovery recorded for a delivered fire, not yet delivered
 */
export async function processAlerts({ conditions, states, settings, nowS, tz, record, notify }) {
  const next = {};
  const sent = [];
  const quiet = inQuietHours(settings, nowS, tz);
  for (const type of ALERT_TYPES) {
    const s = { active: false, fired: false, pending: false, recover_pending: false, since_ts: null, ...(states[type] || {}) };
    const cond = conditions[type] || { active: false, payload: {} };

    if (cond.active && !s.active) {
      s.active = true; s.since_ts = nowS; s.pending = true; s.recover_pending = false;
      await record(type, "fire", cond.payload);
    } else if (!cond.active && s.active) {
      s.active = false;
      await record(type, "recover", cond.payload);
      // Only a delivered fire earns a recovery message; an undelivered one is simply dropped.
      if (s.fired && (settings.alert_recover || type === "auth")) s.recover_pending = true;
      s.pending = false; s.fired = false; s.since_ts = null;
    }
    if (s.active) s.payload = cond.payload;

    if (!quiet) {
      if (s.active && s.pending) {
        if (await notify(type, "fire", cond.payload)) { s.pending = false; s.fired = true; sent.push({ type, direction: "fire" }); }
      } else if (s.recover_pending) {
        if (await notify(type, "recover", cond.payload)) { s.recover_pending = false; sent.push({ type, direction: "recover" }); }
      }
    }
    next[type] = s;
  }
  return { states: next, sent };
}
