// JSON views for the dashboard. Downsampling happens here, server side, so the
// page never receives more than a few thousand points for any range.

import * as db from "./db.js";
import { DAY_S, addDays, exerciseCategory, localDate, localMidnight, tzOffset } from "./ingest.js";
import {
  averageSeries, dedupeBody, dropDuplicateWorkouts, exerciseSeries, mainNights, mergeWorkouts, sleepScore, rangeSpec, rollingMedian,
  sleepSeries, sourceEras, trailingMean,
} from "./metrics.js";
import { buildNotifier } from "./notify.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const tzOf = (env) => env.TZ || "America/New_York";
const nowS = () => Math.floor(Date.now() / 1000);

const parseStages = (json) => { try { return JSON.parse(json || "[]"); } catch { return []; } };

export async function summaryView(env, email) {
  const database = env.DB, tz = tzOf(env), now = nowS();
  const today = localDate(now, tz);

  const latestDate = (await db.first(database, "SELECT MAX(wake_date) AS d FROM nights"))?.d;
  let night = null, rhr = null, rhr30 = null;
  if (latestDate) {
    const rows = await db.all(database, "SELECT * FROM nights WHERE wake_date = ?", latestDate);
    const n = mainNights(rows).get(latestDate);
    night = { ...n, stages: parseStages(n.stages_json) };
    night.score = sleepScore(night.stages, (n.end_ts - n.start_ts) / 60);
    delete night.stages_json;
    rhr = (await db.first(database, "SELECT bpm FROM rhr_daily WHERE date = ?", latestDate))?.bpm ?? null;
    rhr30 = (await db.first(database,
      "SELECT AVG(bpm) AS a, COUNT(*) AS n FROM rhr_daily WHERE date > ? AND date <= ?",
      addDays(latestDate, -30), latestDate))?.a ?? null;
  }
  const todayStart = localMidnight(today, tz);
  const workouts = await db.all(database,
    "SELECT * FROM workouts WHERE start_ts >= ? ORDER BY start_ts", todayStart);

  const status = await db.first(database, `SELECT
      (SELECT MAX(start_ts) + 900 FROM hr_buckets) AS last_hr_end,
      (SELECT MAX(end_ts) FROM nights) AS last_night_end,
      (SELECT MAX(wake_date) FROM nights) AS last_wake_date,
      (SELECT MAX(start_ts) FROM workouts) AS last_workout_start,
      (SELECT type FROM workouts ORDER BY start_ts DESC LIMIT 1) AS last_workout_type,
      (SELECT MAX(ts) FROM body WHERE kind = 'weight_g') AS last_weigh_in`);

  return {
    tz, today, now, email,
    night, rhr, rhr30: rhr30 === null ? null : Math.round(rhr30 * 10) / 10,
    workouts: mergeWorkouts(dropDuplicateWorkouts(workouts.map((w) => ({ ...w, category: exerciseCategory(w.type) })))),
    status,
    meta: await db.getState(database, "meta", {}),
    alerts: await db.getAlertStates(database),
    settings: await db.getSettings(database),
    notifier: buildNotifier(env).name,
  };
}

export async function dayView(env, dateParam) {
  const database = env.DB, tz = tzOf(env), now = nowS();
  const today = localDate(now, tz);
  const date = DATE_RE.test(dateParam || "") && dateParam <= today ? dateParam : today;
  const dayStart = localMidnight(date, tz);
  const dayEnd = localMidnight(addDays(date, 1), tz);

  const rows = await db.all(database, "SELECT * FROM nights WHERE wake_date IN (?, ?)", date, addDays(date, 1));
  const mains = mainNights(rows);
  const n = mains.get(date);
  const night = n ? { ...n, stages: parseStages(n.stages_json) } : null;
  if (night) night.score = sleepScore(night.stages, (n.end_ts - n.start_ts) / 60);
  if (night) delete night.stages_json;
  const next = mains.get(addDays(date, 1));

  const buckets = await db.all(database,
    "SELECT start_ts, min, avg, max FROM hr_buckets WHERE start_ts >= ? AND start_ts < ? ORDER BY start_ts", dayStart, dayEnd);
  const workouts = await db.all(database,
    "SELECT * FROM workouts WHERE start_ts >= ? AND start_ts < ? ORDER BY start_ts", dayStart, dayEnd);
  const bounds = await db.first(database,
    "SELECT MIN(wake_date) AS first_night, (SELECT MIN(start_ts) FROM hr_buckets) AS first_bucket FROM nights");

  return {
    tz, today, date, now, day_start: dayStart, day_end: dayEnd,
    night,
    next_night_start: next && next.start_ts < dayEnd ? next.start_ts : null,
    rhr: (await db.first(database, "SELECT bpm FROM rhr_daily WHERE date = ?", date))?.bpm ?? null,
    buckets,
    workouts: mergeWorkouts(dropDuplicateWorkouts(workouts.map((w) => ({ ...w, category: exerciseCategory(w.type) })))),
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
      (SELECT MIN(start_ts) FROM workouts) AS first_workout`);

  // ---- sleep and resting HR share the nights' calendar
  const sleepSpec = rangeSpec(range, today, bounds?.first_night || today);
  const nights = await db.all(database,
    "SELECT id, wake_date, start_ts, end_ts, deep_min, rem_min, light_min, awake_min, asleep_min FROM nights WHERE wake_date >= ? AND wake_date <= ?",
    sleepSpec.from, today);
  const sleep = sleepSeries(mainNights(nights), sleepSpec.from, today, sleepSpec.grain);

  const rhrRows = await db.all(database, "SELECT date, bpm FROM rhr_daily WHERE date >= ?", addDays(sleepSpec.from, -30));
  const rhrMap = new Map(rhrRows.map((r) => [r.date, r.bpm]));
  const rhrItems = averageSeries(rhrMap, sleepSpec.from, today, sleepSpec.grain);
  const rhrAvg = trailingMean(rhrMap, rhrItems.map((p) => p.b), 30);
  const rhrLatest30 = trailingMean(rhrMap, [today], 30)[0].value;

  // ---- body: readings from 7 days before the range so the first median is honest
  const bodyFromDate = range === "all" && bounds?.first_body ? localDate(bounds.first_body, tz) : rangeSpec(range, today).from;
  const bodyFromS = localMidnight(bodyFromDate, tz);
  const bodyRows = dedupeBody(await db.all(database,
    "SELECT kind, ts, value, source FROM body WHERE ts >= ? ORDER BY ts", bodyFromS - 7 * DAY_S));
  const bodyOut = {};
  for (const kind of ["weight_g", "fat_pct"]) {
    const withMedian = rollingMedian(bodyRows.filter((r) => r.kind === kind), 7).filter((r) => r.ts >= bodyFromS);
    const last = await db.first(database, "SELECT ts, value, source FROM body WHERE kind = ? ORDER BY ts DESC LIMIT 1", kind);
    bodyOut[kind] = {
      from: bodyFromDate,
      points: withMedian.map((r) => ({ ts: r.ts, value: r.value, median: r.median, source: r.source })),
      eras: sourceEras(withMedian),
      last: last || null,
    };
  }

  // ---- exercise: weekly bars read better than 91 thin daily bars
  const exFromDate = range === "all" && bounds?.first_workout ? localDate(bounds.first_workout, tz) : rangeSpec(range, today).from;
  const exGrain = range === "3m" ? "week" : rangeSpec(range, today).grain;
  const wRows = await db.all(database,
    "SELECT type, source, start_ts, end_ts, active_s FROM workouts WHERE start_ts >= ?", localMidnight(exFromDate, tz));
  const exercise = exerciseSeries(
    dropDuplicateWorkouts(wRows.map((w) => ({ ...w, category: exerciseCategory(w.type) }))).map((w) => ({
      date: localDate(w.start_ts, tz),
      category: exerciseCategory(w.type),
      minutes: (w.active_s ?? w.end_ts - w.start_ts) / 60,
    })),
    exFromDate, today, exGrain
  );

  return {
    tz, today, range,
    sleep: { from: sleepSpec.from, grain: sleepSpec.grain, items: sleep },
    rhr: { from: sleepSpec.from, grain: sleepSpec.grain, items: rhrItems, avg: rhrAvg, latest30: rhrLatest30 },
    weight: bodyOut.weight_g,
    fat: bodyOut.fat_pct,
    exercise: { from: exFromDate, grain: exGrain, items: exercise },
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
  };
  const firstBucket = (await db.first(database, "SELECT MIN(start_ts) AS t FROM hr_buckets"))?.t ?? null;

  return {
    tz, today, from, coverage, first_bucket: firstBucket, sources,
    log: await db.all(database, "SELECT ts, trigger, status, detail FROM sync_log ORDER BY id DESC LIMIT 25"),
    meta: await db.getState(database, "meta", {}),
  };
}

export async function exportCsv(env, rangeParam) {
  const database = env.DB, tz = tzOf(env);
  const today = localDate(nowS(), tz);
  const first = (await db.first(database, "SELECT MIN(wake_date) AS d FROM nights"))?.d || today;
  const { from } = rangeSpec(["1w", "1m", "3m", "1y", "all"].includes(rangeParam) ? rangeParam : "3m", today, first);

  const nights = mainNights(await db.all(database, "SELECT * FROM nights WHERE wake_date >= ?", from));
  const rhr = new Map((await db.all(database, "SELECT date, bpm FROM rhr_daily WHERE date >= ?", from)).map((r) => [r.date, r.bpm]));
  const body = dedupeBody(await db.all(database, "SELECT kind, ts, value, source FROM body WHERE ts >= ?", localMidnight(from, tz)));
  const weights = new Map(), fats = new Map();
  for (const b of body) (b.kind === "weight_g" ? weights : fats).set(localDate(b.ts, tz), b);
  const exMin = new Map();
  const exRows = await db.all(database, "SELECT type, source, start_ts, end_ts, active_s FROM workouts WHERE start_ts >= ?", localMidnight(from, tz));
  for (const w of dropDuplicateWorkouts(exRows.map((r) => ({ ...r, category: exerciseCategory(r.type) })))) {
    const d = localDate(w.start_ts, tz);
    exMin.set(d, (exMin.get(d) || 0) + (w.active_s ?? w.end_ts - w.start_ts) / 60);
  }

  const lines = ["date,asleep_min,deep_min,rem_min,light_min,awake_min,resting_hr_bpm,weight_lb,body_fat_pct,scale_source,exercise_min"];
  const cell = (v) => (v === null || v === undefined ? "" : String(v).includes(",") ? `"${v}"` : v);
  for (let d = from; d <= today; d = addDays(d, 1)) {
    const n = nights.get(d), w = weights.get(d), f = fats.get(d);
    lines.push([
      d, n?.asleep_min, n?.deep_min, n?.rem_min, n?.light_min, n?.awake_min, rhr.get(d),
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
