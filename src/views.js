// JSON views for the dashboard. Downsampling happens here, server side, so the
// page never receives more than a few thousand points for any range.

import * as db from "./db.js";
import { DAY_S, addDays, exerciseCategory, localDate, localDateAt, localMidnight, localPartsAt, tzOffset } from "./ingest.js";
import {
  DEFAULT_EXCLUDED_BODY_DATES, DEFAULT_TREND_BREAKS, averageSeries, badNight, circularSdMinutes, cleanBody,
  dropDuplicateWorkouts, exerciseSeries, mainNights, mergeWorkouts, nightScore, onsetMinute, percentile,
  presentMeanSeries, rangeSpec, rollingMedian, sleepSeries, sourceEras, trailingMean, zone2,
} from "./metrics.js";
import { buildNotifier } from "./notify.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const tzOf = (env) => env.TZ || "America/New_York";
const nowS = () => Math.floor(Date.now() / 1000);

const parseStages = (json) => { try { return JSON.parse(json || "[]"); } catch { return []; } };

const SAMSUNG_METRICS = ["sleeping_hr", "sleeping_hrv", "skin_temp_delta", "respiratory_rate", "spo2_avg", "stress_avg"];

/** A main night ready for the page: stages parsed, score (Samsung's when imported), bad-night flag, local clock. */
function presentNight(n, samsung, settings, tz) {
  if (!n) return null;
  const stages = parseStages(n.stages_json);
  const inBed = (n.end_ts - n.start_ts) / 60;
  const out = { ...n, stages, offset_s: n.offset_s ?? null };
  delete out.stages_json;
  out.score = nightScore(stages, inBed, samsung?.sleep_score, settings.sleep_bands);
  out.bad = badNight(stages, inBed);
  const s = localPartsAt(n.start_ts, n.offset_s, tz), e = localPartsAt(n.end_ts, n.offset_s, tz);
  out.local = { start_date: s.date, start_min: s.minutes, end_date: e.date, end_min: e.minutes,
    away: n.offset_s != null && n.offset_s !== tzOffset(n.end_ts, tz) };
  out.samsung = samsung || null;
  return out;
}

/** Workouts whose own local start date is `date` (records abroad keep their own clock). */
async function workoutsOn(database, date, tz) {
  const lo = localMidnight(date, tz) - 14 * 3600, hi = localMidnight(addDays(date, 1), tz) + 14 * 3600;
  const rows = await db.all(database, "SELECT * FROM workouts WHERE start_ts >= ? AND start_ts < ? ORDER BY start_ts", lo, hi);
  const same = rows.filter((w) => localDateAt(w.start_ts, w.offset_s, tz) === date);
  return mergeWorkouts(dropDuplicateWorkouts(same.map((w) => ({ ...w, category: exerciseCategory(w.type) }))));
}

async function zoneFor(database, settings, now) {
  const maxRows = settings.zone_max_hr ? [] : await db.all(database,
    "SELECT max_hr FROM workouts WHERE start_ts >= ? AND max_hr IS NOT NULL", now - 365 * DAY_S);
  const restRows = settings.zone_rest_hr ? [] : await db.all(database, "SELECT bpm FROM rhr_daily ORDER BY date DESC LIMIT 30");
  const maxHr = settings.zone_max_hr || percentile(maxRows.map((r) => r.max_hr), 0.95);
  const restHr = settings.zone_rest_hr || percentile(restRows.map((r) => r.bpm), 0.5);
  const z = zone2({ maxHr, restHr });
  return z ? { ...z, max_source: settings.zone_max_hr ? "setting" : "workouts", rest_source: settings.zone_rest_hr ? "setting" : "sleep" } : null;
}

export async function summaryView(env, email) {
  const database = env.DB, tz = tzOf(env), now = nowS();
  const today = localDate(now, tz);
  const settings = await db.getSettings(database);

  const latestDate = (await db.first(database, "SELECT MAX(wake_date) AS d FROM nights"))?.d;
  let night = null, rhr = null, rhr30 = null;
  if (latestDate) {
    const rows = await db.all(database, "SELECT * FROM nights WHERE wake_date = ?", latestDate);
    const samsung = await db.first(database, "SELECT * FROM samsung_nightly WHERE wake_date = ?", latestDate);
    night = presentNight(mainNights(rows).get(latestDate), samsung, settings, tz);
    rhr = (await db.first(database, "SELECT bpm FROM rhr_daily WHERE date = ?", latestDate))?.bpm ?? null;
    rhr30 = (await db.first(database,
      "SELECT AVG(bpm) AS a, COUNT(*) AS n FROM rhr_daily WHERE date > ? AND date <= ?",
      addDays(latestDate, -30), latestDate))?.a ?? null;
  }
  const workouts = await workoutsOn(database, today, tz);
  const steps = await db.all(database, "SELECT date, steps FROM steps_daily WHERE date >= ? ORDER BY date DESC", addDays(today, -1));

  const status = await db.first(database, `SELECT
      (SELECT MAX(start_ts) + 900 FROM hr_buckets) AS last_hr_end,
      (SELECT MAX(end_ts) FROM nights) AS last_night_end,
      (SELECT MAX(wake_date) FROM nights) AS last_wake_date,
      (SELECT MAX(start_ts) FROM workouts) AS last_workout_start,
      (SELECT type FROM workouts ORDER BY start_ts DESC LIMIT 1) AS last_workout_type,
      (SELECT MAX(ts) FROM body WHERE kind = 'weight_g' AND source NOT IN ('fi.polar.polarflow', 'com.sec.android.app.shealth')) AS last_weigh_in,
      (SELECT MAX(date) FROM steps_daily) AS last_steps_date`);

  return {
    tz, today, now, email,
    night, rhr, rhr30: rhr30 === null ? null : Math.round(rhr30 * 10) / 10,
    workouts,
    steps_today: steps.find((s) => s.date === today)?.steps ?? null,
    steps_yesterday: steps.find((s) => s.date === addDays(today, -1))?.steps ?? null,
    zone2: await zoneFor(database, settings, now),
    status,
    meta: await db.getState(database, "meta", {}),
    samsung_import: await db.getState(database, "samsung_import", null),
    alerts: await db.getAlertStates(database),
    settings,
    notifier: buildNotifier(env).name,
  };
}

export async function dayView(env, dateParam) {
  const database = env.DB, tz = tzOf(env), now = nowS();
  const today = localDate(now, tz);
  const date = DATE_RE.test(dateParam || "") && dateParam <= today ? dateParam : today;
  const settings = await db.getSettings(database);
  const dayStart = localMidnight(date, tz);
  const dayEnd = localMidnight(addDays(date, 1), tz);

  const rows = await db.all(database, "SELECT * FROM nights WHERE wake_date IN (?, ?)", date, addDays(date, 1));
  const mains = mainNights(rows);
  const samsung = await db.first(database, "SELECT * FROM samsung_nightly WHERE wake_date = ?", date);
  const night = presentNight(mains.get(date), samsung, settings, tz);
  const next = mains.get(addDays(date, 1));

  const buckets = await db.all(database,
    "SELECT start_ts, min, avg, max FROM hr_buckets WHERE start_ts >= ? AND start_ts < ? ORDER BY start_ts", dayStart, dayEnd);
  const bounds = await db.first(database,
    "SELECT MIN(wake_date) AS first_night, (SELECT MIN(start_ts) FROM hr_buckets) AS first_bucket FROM nights");

  return {
    tz, today, date, now, day_start: dayStart, day_end: dayEnd,
    night,
    next_night_start: next && next.start_ts < dayEnd ? next.start_ts : null,
    rhr: (await db.first(database, "SELECT bpm FROM rhr_daily WHERE date = ?", date))?.bpm ?? null,
    steps: (await db.first(database, "SELECT steps FROM steps_daily WHERE date = ?", date))?.steps ?? null,
    buckets,
    workouts: await workoutsOn(database, date, tz),
    zone2: await zoneFor(database, settings, now),
    first_night: bounds?.first_night ?? null,
    first_bucket: bounds?.first_bucket ?? null,
  };
}

export async function trendsView(env, rangeParam) {
  const database = env.DB, tz = tzOf(env), now = nowS();
  const today = localDate(now, tz);
  const range = ["1w", "1m", "3m", "1y", "all"].includes(rangeParam) ? rangeParam : "3m";

  const bounds = await db.first(database, `SELECT
      (SELECT MIN(wake_date) FROM nights) AS first_night,
      (SELECT MIN(ts) FROM body) AS first_body,
      (SELECT MIN(start_ts) FROM workouts) AS first_workout,
      (SELECT MIN(date) FROM steps_daily) AS first_steps,
      (SELECT MIN(wake_date) FROM samsung_nightly) AS first_samsung`);

  // ---- sleep and resting HR share the nights' calendar
  const sleepSpec = rangeSpec(range, today, bounds?.first_night || today);
  const withStages = sleepSpec.grain === "day"; // stage JSON only where bars are per night: keeps "all" inside the CPU budget
  const nights = await db.all(database,
    `SELECT id, wake_date, start_ts, end_ts, offset_s, deep_min, rem_min, light_min, awake_min, asleep_min${withStages ? ", stages_json" : ""}
     FROM nights WHERE wake_date >= ? AND wake_date <= ?`,
    sleepSpec.from, today);
  const mains = mainNights(nights);
  const sleep = sleepSeries(mains, sleepSpec.from, today, sleepSpec.grain);
  let onsets = [];
  if (withStages) {
    for (const it of sleep) {
      const n = mains.get(it.key);
      if (!n) continue;
      const b = badNight(parseStages(n.stages_json), (n.end_ts - n.start_ts) / 60);
      if (b) { it.bad = b.bad; it.longest_awake_min = b.longest_awake_min; }
    }
    onsets = [...mains.values()].map((n) => onsetMinute(n, tz));
  } else {
    onsets = [...mains.values()].map((n) => localPartsAt(n.start_ts, n.offset_s, tz).minutes);
  }
  const regularity = { sd_min: circularSdMinutes(onsets), nights: onsets.length, basis: withStages ? "onset" : "bedtime" };

  const rhrRows = await db.all(database, "SELECT date, bpm FROM rhr_daily WHERE date >= ?", addDays(sleepSpec.from, -30));
  const rhrMap = new Map(rhrRows.map((r) => [r.date, r.bpm]));
  const rhrItems = averageSeries(rhrMap, sleepSpec.from, today, sleepSpec.grain);
  const rhrAvg = trailingMean(rhrMap, rhrItems.map((p) => p.b), 30);
  const rhrLatest30 = trailingMean(rhrMap, [today], 30)[0].value;

  // ---- body: readings from 7 days before the range so the first median is honest
  const bodyFromDate = range === "all" && bounds?.first_body ? localDate(bounds.first_body, tz) : rangeSpec(range, today).from;
  const bodyFromS = localMidnight(bodyFromDate, tz);
  const excluded = await db.getState(database, "excluded_body_dates", DEFAULT_EXCLUDED_BODY_DATES);
  const cleaned = cleanBody(await db.all(database,
    "SELECT kind, ts, offset_s, value, source FROM body WHERE ts >= ? ORDER BY ts", bodyFromS - 7 * DAY_S), { excludedDates: excluded, tz });
  const bodyOut = {};
  for (const kind of ["weight_g", "fat_pct"]) {
    const withMedian = rollingMedian(cleaned.scale.filter((r) => r.kind === kind), 7).filter((r) => r.ts >= bodyFromS);
    const last = await db.first(database,
      "SELECT ts, value, source FROM body WHERE kind = ? AND source NOT IN ('fi.polar.polarflow', 'com.sec.android.app.shealth') ORDER BY ts DESC LIMIT 1", kind);
    bodyOut[kind] = {
      from: bodyFromDate,
      points: withMedian.map((r) => ({ ts: r.ts, value: r.value, median: r.median, source: r.source })),
      eras: sourceEras(withMedian),
      last: last || null,
      profile: cleaned.profile.filter((r) => r.kind === kind && r.ts >= bodyFromS).map((r) => ({ ts: r.ts, value: r.value, source: r.source })),
    };
  }
  const bodyDropped = cleaned.dropped;

  // ---- exercise: weekly bars read better than 91 thin daily bars
  const exFromDate = range === "all" && bounds?.first_workout ? localDate(bounds.first_workout, tz) : rangeSpec(range, today).from;
  const exGrain = range === "3m" ? "week" : rangeSpec(range, today).grain;
  const wRows = await db.all(database,
    "SELECT type, source, start_ts, end_ts, offset_s, active_s FROM workouts WHERE start_ts >= ?", localMidnight(exFromDate, tz) - 14 * 3600);
  for (const w of wRows) w.category = exerciseCategory(w.type);
  const exercise = exerciseSeries(
    dropDuplicateWorkouts(wRows).map((w) => ({
      date: localDateAt(w.start_ts, w.offset_s, tz),
      category: w.category,
      minutes: (w.active_s ?? w.end_ts - w.start_ts) / 60,
    })).filter((w) => w.date >= exFromDate),
    exFromDate, today, exGrain
  );

  // ---- steps: Samsung's daily totals; days it did not send stay missing, never zero
  const stepsFrom = range === "all" && bounds?.first_steps ? bounds.first_steps : rangeSpec(range, today).from;
  const stepsGrain = rangeSpec(range, today).grain;
  const stepRows = await db.all(database, "SELECT date, steps FROM steps_daily WHERE date >= ?", stepsFrom);
  const steps = presentMeanSeries(new Map(stepRows.map((r) => [r.date, r.steps])), stepsFrom, today, stepsGrain);

  // ---- Samsung export metrics, only when an import has supplied them
  let samsung = null;
  if (bounds?.first_samsung) {
    const sFrom = range === "all" ? bounds.first_samsung : rangeSpec(range, today).from;
    const sRows = await db.all(database, `SELECT wake_date, ${SAMSUNG_METRICS.join(", ")} FROM samsung_nightly WHERE wake_date >= ?`, sFrom);
    const series = {};
    for (const m of SAMSUNG_METRICS) {
      const map = new Map(sRows.filter((r) => r[m] !== null && r[m] !== undefined).map((r) => [r.wake_date, r[m]]));
      if (map.size) series[m] = presentMeanSeries(map, sFrom, today, rangeSpec(range, today).grain);
    }
    samsung = { from: sFrom, grain: rangeSpec(range, today).grain, series, last_import: await db.getState(database, "samsung_import", null) };
  }

  return {
    tz, today, range,
    sleep: { from: sleepSpec.from, grain: sleepSpec.grain, items: sleep, regularity },
    rhr: { from: sleepSpec.from, grain: sleepSpec.grain, items: rhrItems, avg: rhrAvg, latest30: rhrLatest30 },
    weight: bodyOut.weight_g,
    fat: bodyOut.fat_pct,
    body_cleanup: { ...bodyDropped, excluded_dates: excluded },
    exercise: { from: exFromDate, grain: exGrain, items: exercise },
    steps: { from: stepsFrom, grain: stepsGrain, items: steps },
    samsung,
    breaks: await db.getState(database, "trend_breaks", DEFAULT_TREND_BREAKS),
  };
}

export async function healthView(env) {
  const database = env.DB, tz = tzOf(env), now = nowS();
  const today = localDate(now, tz);
  const from = addDays(today, -26 * 7 + 1);
  // A fixed offset is close enough for a coverage calendar; at a DST change a
  // single bucket can land on the neighbouring day.
  const offset = tzOffset(now, tz);
  const cov = await db.all(database,
    "SELECT (start_ts + CAST(? AS INTEGER)) / 86400 AS d, COUNT(*) AS n FROM hr_buckets WHERE start_ts >= ? GROUP BY d",
    offset, localMidnight(from, tz));
  const coverage = {};
  for (const r of cov) coverage[new Date(r.d * 86400_000).toISOString().slice(0, 10)] = r.n;

  const sources = {
    sleep: await db.all(database, "SELECT source, MIN(start_ts) AS a, MAX(end_ts) AS b, COUNT(*) AS n FROM nights GROUP BY source"),
    workouts: await db.all(database, "SELECT source, MIN(start_ts) AS a, MAX(end_ts) AS b, COUNT(*) AS n FROM workouts GROUP BY source"),
    weight: await db.all(database, "SELECT source, MIN(ts) AS a, MAX(ts) AS b, COUNT(*) AS n FROM body WHERE kind = 'weight_g' GROUP BY source"),
    fat: await db.all(database, "SELECT source, MIN(ts) AS a, MAX(ts) AS b, COUNT(*) AS n FROM body WHERE kind = 'fat_pct' GROUP BY source"),
    steps: await db.all(database, "SELECT source, MIN(date) AS a_date, MAX(date) AS b_date, COUNT(*) AS n FROM steps_daily GROUP BY source"),
  };
  const firstBucket = (await db.first(database, "SELECT MIN(start_ts) AS t FROM hr_buckets"))?.t ?? null;

  return {
    tz, today, from, coverage, first_bucket: firstBucket, sources,
    log: await db.all(database, "SELECT ts, trigger, status, detail FROM sync_log ORDER BY id DESC LIMIT 25"),
    meta: await db.getState(database, "meta", {}),
    samsung_import: await db.getState(database, "samsung_import", null),
  };
}

export async function exportCsv(env, rangeParam) {
  const database = env.DB, tz = tzOf(env);
  const today = localDate(nowS(), tz);
  const first = (await db.first(database, "SELECT MIN(wake_date) AS d FROM nights"))?.d || today;
  const { from } = rangeSpec(["1w", "1m", "3m", "1y", "all"].includes(rangeParam) ? rangeParam : "3m", today, first);
  const settings = await db.getSettings(database);

  const nights = mainNights(await db.all(database, "SELECT * FROM nights WHERE wake_date >= ?", from));
  const samsung = new Map((await db.all(database, "SELECT wake_date, sleep_score FROM samsung_nightly WHERE wake_date >= ?", from)).map((r) => [r.wake_date, r.sleep_score]));
  const rhr = new Map((await db.all(database, "SELECT date, bpm FROM rhr_daily WHERE date >= ?", from)).map((r) => [r.date, r.bpm]));
  const steps = new Map((await db.all(database, "SELECT date, steps FROM steps_daily WHERE date >= ?", from)).map((r) => [r.date, r.steps]));
  const excluded = await db.getState(database, "excluded_body_dates", DEFAULT_EXCLUDED_BODY_DATES);
  const body = cleanBody(await db.all(database, "SELECT kind, ts, offset_s, value, source FROM body WHERE ts >= ?", localMidnight(from, tz) - DAY_S),
    { excludedDates: excluded, tz }).scale;
  const weights = new Map(), fats = new Map();
  for (const b of body) (b.kind === "weight_g" ? weights : fats).set(localDateAt(b.ts, b.offset_s, tz), b);
  const exMin = new Map();
  const exRows = await db.all(database, "SELECT type, source, start_ts, end_ts, offset_s, active_s FROM workouts WHERE start_ts >= ?", localMidnight(from, tz) - DAY_S);
  for (const w of dropDuplicateWorkouts(exRows.map((r) => ({ ...r, category: exerciseCategory(r.type) })))) {
    const d = localDateAt(w.start_ts, w.offset_s, tz);
    exMin.set(d, (exMin.get(d) || 0) + (w.active_s ?? w.end_ts - w.start_ts) / 60);
  }

  const lines = ["date,asleep_min,deep_min,rem_min,light_min,awake_min,sleep_score,sleep_label,score_source,lowest_sleeping_hr_bpm,steps,weight_lb,body_fat_pct,scale_source,exercise_min"];
  const cell = (v) => (v === null || v === undefined ? "" : String(v).includes(",") ? `"${v}"` : v);
  for (let d = from; d <= today; d = addDays(d, 1)) {
    const n = nights.get(d), w = weights.get(d), f = fats.get(d);
    const sc = n ? nightScore(parseStages(n.stages_json), (n.end_ts - n.start_ts) / 60, samsung.get(d), settings.sleep_bands) : null;
    lines.push([
      d, n?.asleep_min, n?.deep_min, n?.rem_min, n?.light_min, n?.awake_min,
      sc?.score, sc?.label, sc ? (sc.samsung ? "samsung" : "estimate") : null, rhr.get(d), steps.get(d),
      w ? Math.round((w.value / 453.59237) * 10) / 10 : null, f?.value, (w || f)?.source,
      exMin.has(d) ? Math.round(exMin.get(d)) : null,
    ].map(cell).join(","));
  }
  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="health-${from}-to-${today}.csv"`,
      "cache-control": "no-store",
    },
  });
}
