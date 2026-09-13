// Google Health API JSON -> row objects. PURE: no I/O, no globals, so the
// Worker and the local backfill tool share one definition of every row.
//
// Units on the way in are kept as the API returns them (grams, percent,
// epoch seconds). Conversion to pounds happens only at display time.

export const DAY_S = 86400;
export const BUCKET_S = 900;

export const toEpoch = (iso) => Math.floor(Date.parse(iso) / 1000);
export const isoOf = (epochS) => new Date(epochS * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

const dateFormatters = new Map();
function dateFormatter(tz) {
  if (!dateFormatters.has(tz)) {
    dateFormatters.set(
      tz,
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      })
    );
  }
  return dateFormatters.get(tz);
}

function intlParts(epochS, tz) {
  const parts = Object.fromEntries(
    dateFormatter(tz).formatToParts(new Date(epochS * 1000)).map((p) => [p.type, p.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function intlOffset(epochS, tz) {
  const p = intlParts(epochS, tz);
  const [y, m, d] = p.date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 1000 + p.minutes * 60 - Math.floor(epochS / 60) * 60;
}

// Intl.formatToParts costs several microseconds a call, and the "all" range
// converts thousands of timestamps inside a 10 ms CPU budget. The offset only
// changes at DST transitions, so cache it per UTC month when the month has no
// transition, per UTC day inside transition months, and ask Intl directly only
// for instants on a transition day. (A zone that changes and changes back
// within one month would defeat the monthly check; none relevant here do.)
const offsetCaches = new Map(); // tz -> Map(numeric key -> offset | null)
function cachedSpan(cache, key, startS, endS, tz) {
  let v = cache.get(key);
  if (v === undefined) {
    const a = intlOffset(startS, tz), b = intlOffset(endS, tz);
    v = a === b ? a : null;
    cache.set(key, v);
  }
  return v;
}

/** Offset of `tz` from UTC in seconds at an instant (negative west of Greenwich). */
export function tzOffset(epochS, tz) {
  let cache = offsetCaches.get(tz);
  if (!cache) { cache = new Map(); offsetCaches.set(tz, cache); }
  const d = new Date(epochS * 1000);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  // Positive keys are months, negative keys are days.
  const month = cachedSpan(cache, y * 12 + m + 1, Date.UTC(y, m, 1) / 1000, Date.UTC(y, m + 1, 1) / 1000 - 60, tz);
  if (month !== null) return month;
  const day = Math.floor(epochS / 86400);
  const daily = cachedSpan(cache, -(day + 1_000_000), day * 86400, day * 86400 + 86340, tz);
  return daily !== null ? daily : intlOffset(epochS, tz);
}

const dayStrings = new Map();
const dayString = (n) => {
  let s = dayStrings.get(n);
  if (!s) { s = new Date(n * 86400000).toISOString().slice(0, 10); dayStrings.set(n, s); }
  return s;
};

/** Local calendar parts for an instant: { date: "YYYY-MM-DD", minutes: 0..1439 }. */
export function localParts(epochS, tz) {
  const local = epochS + tzOffset(epochS, tz);
  const day = Math.floor(local / 86400);
  return { date: dayString(day), minutes: Math.floor((local - day * 86400) / 60) };
}

export const localDate = (epochS, tz) => localParts(epochS, tz).date;

/** Epoch seconds of local midnight starting `date` in `tz`. DST-safe. */
export function localMidnight(date, tz) {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d) / 1000;
  // Two passes: the offset at the guessed instant can differ from the offset at
  // the real local midnight when a DST change sits between them.
  let t = guess - tzOffset(guess, tz);
  t = guess - tzOffset(t, tz);
  return t;
}

/** Calendar arithmetic on YYYY-MM-DD strings. */
export function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export const idOf = (dp) => String(dp.name || "").split("/").pop();

export function sourceOf(dp) {
  const ds = dp.dataSource || {};
  return (
    ds.application?.packageName ||
    ds.device?.displayName ||
    ds.platform ||
    "unknown"
  );
}

// Stage codes stored in stages_json. "s" is asleep with no stage detail (older
// Fitbit "classic" nights), counted as asleep but in no stage bucket.
const STAGE_CODE = {
  DEEP: "d", REM: "r", LIGHT: "l", AWAKE: "a",
  ASLEEP: "s", SLEEPING: "s", RESTLESS: "a", OUT_OF_BED: "a",
};
const round1 = (v) => Math.round(v * 10) / 10;

/**
 * Compact stage list: [[offsetMin, lenMin, code], ...] relative to session
 * start, sorted, adjacent same-stage segments merged.
 */
export function compactStages(stages, startS) {
  const segs = (stages || [])
    .map((st) => ({ s: toEpoch(st.startTime), e: toEpoch(st.endTime), c: STAGE_CODE[st.type] }))
    .filter((x) => x.c && Number.isFinite(x.s) && Number.isFinite(x.e) && x.e > x.s)
    .sort((a, b) => a.s - b.s);
  const out = [];
  for (const x of segs) {
    const last = out[out.length - 1];
    if (last && last.c === x.c && Math.abs(last.e - x.s) <= 1) last.e = Math.max(last.e, x.e);
    else out.push({ ...x });
  }
  return out.map((x) => [round1((x.s - startS) / 60), round1((x.e - x.s) / 60), x.c]);
}

export function stageTotals(compact) {
  const t = { d: 0, r: 0, l: 0, a: 0, s: 0 };
  for (const [, len, c] of compact) t[c] += len;
  return {
    deep_min: round1(t.d), rem_min: round1(t.r), light_min: round1(t.l), awake_min: round1(t.a),
    asleep_min: round1(t.d + t.r + t.l + t.s),
  };
}

export function nightRow(dp, tz) {
  const s = dp.sleep || {};
  const start = toEpoch(s.interval?.startTime);
  const end = toEpoch(s.interval?.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const compact = compactStages(s.stages, start);
  const totals = compact.length
    ? stageTotals(compact)
    : { deep_min: 0, rem_min: 0, light_min: 0, awake_min: 0, asleep_min: round1((end - start) / 60) };
  return {
    id: idOf(dp),
    wake_date: localDate(end, tz),
    start_ts: start,
    end_ts: end,
    source: sourceOf(dp),
    ...totals,
    stages_json: JSON.stringify(compact),
    updated_at: s.updateTime || dp.updateTime || null,
  };
}

export function exerciseCategory(type) {
  const t = String(type || "").toUpperCase();
  // Observed types include SWIMMING, BIKING, OUTDOOR_BIKE, SPINNING.
  if (t.includes("SWIM")) return "Swimming";
  if (t.includes("BIK") || t.includes("CYCL") || t === "SPINNING") return "Biking";
  return "Other";
}

const seconds = (dur) => {
  const m = /^(-?\d+(?:\.\d+)?)s$/.exec(String(dur || ""));
  return m ? Number(m[1]) : null;
};

export function workoutRow(dp) {
  const e = dp.exercise || {};
  const start = toEpoch(e.interval?.startTime);
  const end = toEpoch(e.interval?.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const avg = Number(e.metricsSummary?.averageHeartRateBeatsPerMinute);
  return {
    id: idOf(dp),
    type: e.exerciseType || "UNKNOWN",
    name: e.displayName || null,
    start_ts: start,
    end_ts: end,
    active_s: seconds(e.activeDuration) ?? end - start,
    avg_hr: Number.isFinite(avg) && avg > 0 ? avg : null,
    max_hr: null, // filled from hr_buckets after they are stored
    source: sourceOf(dp),
  };
}

export function bodyRow(dp, kind) {
  const src = kind === "weight_g" ? dp.weight : dp.bodyFat;
  if (!src) return null;
  const ts = toEpoch(src.sampleTime?.physicalTime);
  const value = kind === "weight_g" ? Number(src.weightGrams) : Number(src.percentage);
  if (!Number.isFinite(ts) || !Number.isFinite(value)) return null;
  return { id: `${kind === "weight_g" ? "w" : "f"}:${idOf(dp)}`, kind, ts, value, source: sourceOf(dp) };
}

export function bucketRows(rollupDataPoints) {
  const out = [];
  for (const p of rollupDataPoints || []) {
    const hr = p.heartRate || {};
    const start = toEpoch(p.startTime);
    const avg = Number(hr.beatsPerMinuteAvg);
    if (!Number.isFinite(start) || !Number.isFinite(avg)) continue;
    out.push({
      start_ts: start,
      min: Number(hr.beatsPerMinuteMin),
      avg: round1(avg),
      max: Number(hr.beatsPerMinuteMax),
    });
  }
  return out.sort((a, b) => a.start_ts - b.start_ts);
}
