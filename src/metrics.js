// Derived numbers and the alert state machine. PURE: plain objects in, plain
// objects out. Everything here runs under `node --test` with no D1 and no
// network, the same discipline as detect.js in the Nest project.

import { BUCKET_S, DAY_S, addDays, localDateAt, localParts, localPartsAt } from "./ingest.js";

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

/*
 * Split nights. Samsung sometimes records one night as two or more sessions
 * around a wake-up. In its own export such sessions share a combined_id; the
 * gaps between them reached 199 minutes, with 94% at or under 120 minutes, while
 * sessions it did NOT combine were a nap or a separate night hours apart. Health
 * Connect carries no combined_id, so sessions ending on the same wake date and
 * separated by at most SPLIT_NIGHT_GAP_S are joined here, the gap counting as
 * awake time.
 */
export const SPLIT_NIGHT_GAP_S = 120 * 60;

const parseStagesJson = (j) => { if (Array.isArray(j)) return j; try { return JSON.parse(j || "[]"); } catch { return []; } };

/** Join same-wake-date sessions separated by <= gapS. Rows keep the nights-table shape. */
export function mergeSplitNights(nights, gapS = SPLIT_NIGHT_GAP_S) {
  // One sort and one pass: the "all" range walks thousands of nights inside the CPU budget.
  const sorted = nights.slice().sort((a, b) => (a.wake_date < b.wake_date ? -1 : a.wake_date > b.wake_date ? 1 : a.start_ts - b.start_ts));
  const out = [];
  let cur = null, curIsCopy = false;
  const finish = () => {
    if (!cur) return;
    if (curIsCopy && cur._stages) cur.stages_json = JSON.stringify(cur._stages);
    if (curIsCopy) delete cur._stages;
    out.push(cur);
  };
  for (const n of sorted) {
    if (cur && n.wake_date === cur.wake_date && n.start_ts - cur.end_ts <= gapS && n.start_ts >= cur.end_ts - 60) {
      if (!curIsCopy) {
        cur = { ...cur, ids: [cur.id], parts: 1, _stages: cur.stages_json !== undefined ? parseStagesJson(cur.stages_json).slice() : null };
        curIsCopy = true;
      }
      const gapMin = Math.max(0, (n.start_ts - cur.end_ts) / 60);
      if (cur._stages && n.stages_json !== undefined) {
        const off = (cur.end_ts - cur.start_ts) / 60;
        if (gapMin > 0) cur._stages.push([Math.round(off * 10) / 10, Math.round(gapMin * 10) / 10, "a"]);
        const base = (n.start_ts - cur.start_ts) / 60;
        for (const [o, len, c] of parseStagesJson(n.stages_json)) cur._stages.push([Math.round((base + o) * 10) / 10, len, c]);
      }
      for (const k of ["deep_min", "rem_min", "light_min", "asleep_min"]) cur[k] = (cur[k] || 0) + (n[k] || 0);
      cur.awake_min = (cur.awake_min || 0) + (n.awake_min || 0) + gapMin;
      cur.end_ts = Math.max(cur.end_ts, n.end_ts);
      cur.offset_s = n.offset_s ?? cur.offset_s;
      cur.ids.push(n.id);
      cur.parts += 1;
    } else {
      finish();
      cur = n;
      curIsCopy = false;
    }
  }
  finish();
  return out;
}

/** For each wake_date the longest night after joining split sessions: naps must not replace the night. */
export function mainNights(nights) {
  const best = new Map();
  for (const n of mergeSplitNights(nights)) {
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

// Weight entries from these apps are profile values typed into the app, not scale readings.
export const PROFILE_WEIGHT_SOURCES = new Set(["fi.polar.polarflow", "com.sec.android.app.shealth"]);
// Local dates whose body readings are known to be wrong (for example a scale app that stamped old
// readings with the sync date). Stored in state "excluded_body_dates"; empty by default.
// Example value: ["YYYY-MM-DD", "YYYY-MM-DD"]
export const DEFAULT_EXCLUDED_BODY_DATES = [];

/**
 * Scale readings fit to chart. Rules, in order:
 *  1. Profile entries (Polar Flow, Samsung Health) leave the scale series and are returned as `profile`.
 *  2. A FITBIT_WEB_API reading that mirrors another source (same kind and value within 120 s) is dropped:
 *     some scale apps also write through the Fitbit API, so every weigh-in would count twice.
 *  3. Same-source re-weighs of one kind within 30 minutes collapse to the last one.
 *  4. Readings on excluded local dates (a stored list, not code) are dropped.
 * readings: {kind, ts, value, source, offset_s?}. Output sorted by ts.
 */
export function cleanBody(readings, { excludedDates = DEFAULT_EXCLUDED_BODY_DATES, tz = "America/New_York" } = {}) {
  const sorted = readings.slice().sort((a, b) => a.ts - b.ts); // same-source repeat writes collapse in rule 3
  const profile = [], scale = [];
  for (const r of sorted) (PROFILE_WEIGHT_SOURCES.has(r.source) ? profile : scale).push(r);
  // scale is sorted by ts, so the mirror search only scans neighbours within 120 s (linear, not quadratic).
  const mirrored = new Set();
  for (let i = 0; i < scale.length; i++) {
    const r = scale[i];
    if (r.source !== "FITBIT_WEB_API") continue;
    for (let j = i - 1; j >= 0 && r.ts - scale[j].ts <= 120; j--) {
      const o = scale[j];
      if (o.source !== "FITBIT_WEB_API" && o.kind === r.kind && Math.abs(o.value - r.value) < 1e-6) { mirrored.add(r); break; }
    }
    if (mirrored.has(r)) continue;
    for (let j = i + 1; j < scale.length && scale[j].ts - r.ts <= 120; j++) {
      const o = scale[j];
      if (o.source !== "FITBIT_WEB_API" && o.kind === r.kind && Math.abs(o.value - r.value) < 1e-6) { mirrored.add(r); break; }
    }
  }
  const noMirror = scale.filter((r) => !mirrored.has(r));
  const collapsed = [];
  const lastIdx = new Map();
  for (const r of noMirror) {
    const key = r.kind + "|" + r.source;
    const prevIdx = lastIdx.get(key);
    if (prevIdx !== undefined && r.ts - collapsed[prevIdx].ts <= 30 * 60) collapsed[prevIdx] = r;
    else { lastIdx.set(key, collapsed.length); collapsed.push(r); }
  }
  const excluded = new Set(excludedDates || []);
  const kept = collapsed.filter((r) => !excluded.has(localDateAt(r.ts, r.offset_s, tz)));
  return { scale: kept, profile, dropped: { mirrored: mirrored.size, rewrites: noMirror.length - collapsed.length, excluded: collapsed.length - kept.length } };
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
      const b = dateOf(Date.UTC(y, m, 1) / DAY_MS - 1); // last day of the month, via cached day strings
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
  // Sweep in start order: only workouts that overlap in time can be duplicates, so each one is
  // compared with the few still running, not with every other workout.
  const items = workouts.map((w) => ({ w, rank: WORKOUT_SOURCE_RANK[w.source] || 1, dur: w.end_ts - w.start_ts, lost: false }));
  items.sort((a, b) => a.w.start_ts - b.w.start_ts);
  const active = [];
  for (const it of items) {
    for (let i = active.length - 1; i >= 0; i--) if (active[i].w.end_ts <= it.w.start_ts) active.splice(i, 1);
    for (const o of active) {
      const a = it.w, b = o.w;
      if (a.category !== b.category || a.source === b.source) continue;
      if (Math.min(a.end_ts, b.end_ts) - Math.max(a.start_ts, b.start_ts) < 0.5 * Math.min(it.dur, o.dur)) continue;
      // Higher-ranked source wins; on a tie the longer session wins.
      const itWins = it.rank !== o.rank ? it.rank > o.rank : it.dur > o.dur;
      if (itWins) o.lost = true; else it.lost = true;
    }
    active.push(it);
  }
  return items.filter((it) => !it.lost).map((it) => it.w);
}

/*
 * Samsung auto-pause starts a new session at every stop. In Samsung's own export,
 * gaps between consecutive bike sessions cluster under 5 minutes, thin out by 25,
 * and are sparse between 45 and 70 minutes; nothing in the export links segments.
 * 25 minutes joins stops at lights and short breaks without joining separate rides.
 */
export const WORKOUT_MERGE_GAP_S = 25 * 60;

/**
 * Join workouts of the same category that follow each other within `gapS`.
 * Stored rows stay untouched so the rule can change later. Input sorted or not;
 * output sorted by start.
 */
export function mergeWorkouts(workouts, gapS = WORKOUT_MERGE_GAP_S) {
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

// piecewise-linear: points [[x, y], ...] sorted by x, clamped at both ends
export function curve(x, points) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i], [x0, y0] = points[i - 1];
    if (x <= x1) return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }
  return points[points.length - 1][1];
}

const parseStagesArr = (j) => { if (Array.isArray(j)) return j; try { return JSON.parse(j || "[]"); } catch { return []; } };

/**
 * Facts behind a night's score, from compact stages [[offsetMin, lenMin, code]].
 * Awake time counts only between the first and last sleep (lying awake before
 * sleep onset is latency, which efficiency already carries). A cycle ends with a
 * REM episode; REM blocks less than 20 minutes apart are one episode.
 */
export function sleepFacts(stages, inBedMin) {
  if (!stages || !stages.length || !(inBedMin > 0)) return null;
  const t = { d: 0, r: 0, l: 0, a: 0, s: 0 };
  for (const [, len, c] of stages) t[c] = (t[c] || 0) + len;
  const asleep = t.d + t.r + t.l + t.s;
  if (asleep < 60) return null;
  const firstSleep = stages.findIndex((x) => x[2] !== "a");
  let lastSleep = stages.length - 1;
  while (lastSleep > 0 && stages[lastSleep][2] === "a") lastSleep--;
  let waso = 0, wakeups = 0, longestAwake = 0;
  for (let i = firstSleep; i <= lastSleep; i++) {
    if (stages[i][2] === "a") {
      waso += stages[i][1];
      if (stages[i][1] >= 3) wakeups++;
      longestAwake = Math.max(longestAwake, stages[i][1]);
    }
  }
  let cycles = 0, lastRemEnd = -Infinity;
  for (const [off, len, c] of stages) {
    if (c !== "r") continue;
    if (off - lastRemEnd >= 20) cycles++;
    lastRemEnd = off + len;
  }
  return {
    asleep_min: asleep, hours: asleep / 60, efficiency: asleep / inBedMin,
    deep_frac: t.d / asleep, rem_frac: t.r / asleep, waso_min: waso, wakeups, cycles,
    longest_awake_min: longestAwake, onset_offset_min: stages[firstSleep] ? stages[firstSleep][0] : 0,
  };
}

/*
 * SLEEP_MODEL is fitted, not hand-set: tools/fit_sleep_score.py regresses
 * Samsung's own sleep_score (from the "Download personal data" export) on the
 * facts above for main nights present in both sources, holding out one night in
 * five for validation. Each factor contributes points through a piecewise curve
 * (values at fixed knots); the score is the intercept plus the sum, clamped to
 * 0..100. The constants shipped here were fitted on one person's nights; re-run
 * the script on your own export to refit them for you.
 */
export const SLEEP_MODEL = /* fitted: begin */ {"intercept": 38.01, "curves": {"hours": [[5.75, 0.0], [7.5, 12.83], [8.25, 10.69], [9.25, 1.49]], "efficiency": [[0.68, 0.0], [0.84, 8.68], [0.9, 11.83], [0.94, 12.26]], "deep_frac": [[0.02, 0.0], [0.08, 9.42], [0.11, 12.18], [0.18, 12.18]], "rem_frac": [[0.17, 0.0], [0.23, 4.99], [0.27, 4.99], [0.46, 9.57]], "waso_min": [[25, 4.16], [50, 4.16], [85, 4.16], [175, 0.0]], "wakeups": [[1, 2.95], [2, 2.07], [4, 0.0], [10, 0.0]], "cycles": [[3, 0.0], [5, 2.04], [6, 3.72], [7, 5.65]]}, "cap": [[4, 40], [6, 76], [7, 97]]} /* fitted: end */;

/*
 * Samsung shows four labels but does not publish the score cutoffs. These bands
 * are an assumption, consistent with the one score-and-label pair the user has
 * confirmed so far. They are a setting (sleep_bands), so another confirmed label
 * can move them without a code change.
 */
export const DEFAULT_SLEEP_BANDS = [90, 70, 50];
export const SLEEP_BANDS = DEFAULT_SLEEP_BANDS;

export function sleepLabel(score, bands = DEFAULT_SLEEP_BANDS) {
  const [ex, good, fair] = bands;
  return score >= ex ? "Excellent" : score >= good ? "Good" : score >= fair ? "Fair" : "Attention";
}

/** stages: compact [[offsetMin, lenMin, code]]. Returns null for nights without stage detail. */
export function sleepScore(stages, inBedMin, bands = DEFAULT_SLEEP_BANDS, model = SLEEP_MODEL) {
  const f = sleepFacts(stages, inBedMin);
  if (!f) return null;
  const parts = {};
  let total = model.intercept;
  for (const k of Object.keys(model.curves)) { parts[k] = curve(f[k], model.curves[k]); total += parts[k]; }
  // The cap is a hand-set prior, not fitted: recorded short nights are too few to teach it.
  const cap = model.cap ? curve(f.hours, model.cap.concat([[24, 100]])) : 100;
  const score = Math.round(Math.max(0, Math.min(100, cap, total)));
  return {
    score, label: sleepLabel(score, bands), estimate: true,
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 10) / 10])),
    facts: {
      asleep_min: Math.round(f.asleep_min), efficiency: Math.round(f.efficiency * 100), deep_pct: Math.round(f.deep_frac * 100),
      rem_pct: Math.round(f.rem_frac * 100), waso_min: Math.round(f.waso_min), wakeups: f.wakeups, cycles: f.cycles,
    },
  };
}

/** Samsung's own score when the export supplied one, otherwise our estimate. */
export function nightScore(stages, inBedMin, samsungScore, bands = DEFAULT_SLEEP_BANDS) {
  const est = sleepScore(stages, inBedMin, bands);
  const n = samsungScore === null || samsungScore === undefined ? NaN : Number(samsungScore);
  if (!Number.isFinite(n)) return est;
  const score = Math.round(n);
  return { score, label: sleepLabel(score, bands), estimate: false, samsung: true, facts: est ? est.facts : null, ours: est ? est.score : null };
}

// ------------------------------------------------------------ signals

/** A night with an awakening of 15 minutes or more between first and last sleep. */
export const BAD_NIGHT_AWAKE_MIN = 15;
export function badNight(stages, inBedMin) {
  const f = sleepFacts(stages, inBedMin);
  return f ? { bad: f.longest_awake_min >= BAD_NIGHT_AWAKE_MIN, longest_awake_min: Math.round(f.longest_awake_min) } : null;
}

/**
 * Bedtime regularity: circular standard deviation of sleep-onset clock time, in
 * minutes. Circular so 23:50 and 00:10 are 20 minutes apart, not 23 hours.
 * onsetMinutes: local minutes after midnight (0..1439). Needs 3 or more nights.
 */
export function circularSdMinutes(onsetMinutes) {
  const xs = onsetMinutes.filter((m) => Number.isFinite(m));
  if (xs.length < 3) return null;
  let c = 0, s = 0;
  for (const m of xs) { const a = (m / 1440) * 2 * Math.PI; c += Math.cos(a); s += Math.sin(a); }
  const r = Math.sqrt(c * c + s * s) / xs.length;
  if (r <= 1e-9) return 720;
  return Math.round((Math.sqrt(-2 * Math.log(r)) / (2 * Math.PI)) * 1440);
}

/** Local clock minute of sleep onset (first non-awake segment), using the night's own offset. */
export function onsetMinute(night, tz) {
  const st = parseStagesArr(night.stages_json ?? night.stages);
  const first = st.find((x) => x[2] !== "a");
  const t = night.start_ts + Math.round((first ? first[0] : 0) * 60);
  return localPartsAt(t, night.offset_s, tz).minutes;
}

/**
 * Zone 2 by heart-rate reserve (Karvonen), 60 to 70 percent: rest + 0.6..0.7 x (max - rest).
 * An estimate from the user's own data, not a clinical number.
 */
export function zone2({ maxHr, restHr }) {
  if (!(maxHr > 0) || !(restHr > 0) || maxHr <= restHr + 20) return null;
  const reserve = maxHr - restHr;
  return { lo: Math.round(restHr + 0.6 * reserve), hi: Math.round(restHr + 0.7 * reserve), max_hr: Math.round(maxHr), rest_hr: Math.round(restHr) };
}

export function percentile(values, p) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const i = (xs.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return xs[lo] + (xs[hi] - xs[lo]) * (i - lo);
}

/** Known algorithm or firmware changes, drawn as markers on trends. Stored in state "trend_breaks"; this is the default. */
// Empty by default: breaks are specific to a device and firmware history. Example entry:
// { date: "YYYY-MM-DD", metric: "hrv", note: "Vendor changed its HRV algorithm" }
// Metrics used by the dashboard: "hrv", "spo2", "sleep_awake", "rhr", "weight".
export const DEFAULT_TREND_BREAKS = [];

/** Daily values (Map date -> number) averaged per period over the days that HAVE a value; empty periods stay null. */
export function presentMeanSeries(dailyMap, from, to, grain) {
  return periods(from, to, grain).map((p) => {
    let s = 0, n = 0;
    for (let d = dayNum(p.a), end = dayNum(p.b); d <= end; d++) {
      const v = dailyMap.get(dateOf(d));
      if (v !== undefined && v !== null) { s += v; n++; }
    }
    return { ...p, n, value: n ? Math.round((s / n) * 10) / 10 : null };
  });
}

// ------------------------------------------------------------ alerts

export const ALERT_TYPES = ["stale", "failing", "auth"];

export const DEFAULT_SETTINGS = {
  zone_max_hr: null,
  zone_rest_hr: null,
  sleep_bands: DEFAULT_SLEEP_BANDS,
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
  const optHr = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 30 && n <= 230 ? n : null;
  };
  s.zone_max_hr = optHr(s.zone_max_hr);
  s.zone_rest_hr = optHr(s.zone_rest_hr);
  const b = Array.isArray(s.sleep_bands) ? s.sleep_bands.map(Number) : [];
  s.sleep_bands = b.length === 3 && b.every((x) => Number.isFinite(x) && x >= 0 && x <= 100) && b[0] > b[1] && b[1] > b[2]
    ? b : DEFAULT_SLEEP_BANDS;
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
