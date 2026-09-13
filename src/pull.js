// One pull: Google -> D1 -> resting HR -> alerts. Never throws; a failure
// becomes a sync_log row and a counter the alert logic reads.

import * as db from "./db.js";
import * as google from "./google.js";
import { DAY_S, bodyRow, bucketRows, isoOf, localDate, nightRow, toEpoch, workoutRow } from "./ingest.js";
import { evaluateConditions, message, processAlerts, restingHrRows } from "./metrics.js";
import { buildNotifier } from "./notify.js";

export async function pullOnce(env, trigger = "cron") {
  const database = env.DB;
  const tz = env.TZ || "America/New_York";
  const nowS = Math.floor(Date.now() / 1000);
  const settings = await db.getSettings(database);
  const meta = await db.getState(database, "meta", {});
  const counter = google.makeCounter(30);

  const lastDataBefore = await db.lastDataTs(database);
  const lastHr = (await db.first(database, "SELECT MAX(start_ts) AS t FROM hr_buckets"))?.t ?? null;
  // Re-read an overlapping window every run: upserts are idempotent, and data
  // that reaches Google late (a phone that was not syncing) is picked up the
  // next time. After an outage, widen the window up to the rollUp maximum.
  let days = 3;
  if (!lastHr) days = 14;
  else if (nowS - lastHr > 3 * DAY_S) days = Math.min(14, Math.ceil((nowS - lastHr) / DAY_S) + 1);
  // rollUp windows start at the range start, not on the clock: an unaligned
  // start would produce buckets at :07, :22... that never match stored rows.
  const sinceS = Math.floor((nowS - days * DAY_S) / 900) * 900;
  const endS = Math.floor(nowS / 900) * 900; // the bucket in progress is read next run
  const sinceIso = isoOf(sinceS);

  const counts = {};
  let error = null;
  let authFailed = false;

  try {
    const token = await google.accessToken(
      { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, refreshToken: env.GOOGLE_REFRESH_TOKEN },
      counter
    );

    const buckets = bucketRows(await google.rollUp(token, "heart-rate", sinceIso, isoOf(endS), "900s", counter));

    const nights = (await google.listPoints(token, "sleep",
      { filter: `sleep.interval.end_time >= "${sinceIso}"`, pageSize: 25, maxPages: 3 }, counter))
      .map((p) => nightRow(p, tz)).filter(Boolean);

    // Exercise rejects every date filter; list newest first and stop once past the window.
    const workouts = (await google.listPoints(token, "exercise",
      { pageSize: 25, maxPages: 3, stopWhen: (p) => toEpoch(p.exercise?.interval?.startTime) < sinceS }, counter))
      .map(workoutRow).filter((w) => w && w.end_ts >= sinceS);

    const weight = await google.listPoints(token, "weight",
      { filter: `weight.sample_time.physical_time >= "${sinceIso}"`, pageSize: 200, maxPages: 2 }, counter);
    const fat = await google.listPoints(token, "body-fat",
      { filter: `body_fat.sample_time.physical_time >= "${sinceIso}"`, pageSize: 200, maxPages: 2 }, counter);
    const body = [...weight.map((p) => bodyRow(p, "weight_g")), ...fat.map((p) => bodyRow(p, "fat_pct"))].filter(Boolean);

    await db.runStatements(database, [
      ...db.upsertSql("hr_buckets", buckets),
      ...db.upsertSql("nights", nights),
      ...db.upsertSql("workouts", workouts),
      ...db.upsertSql("body", body),
      db.workoutMaxHrSql(sinceS - DAY_S),
    ]);

    // Resting HR for every wake date the window touched, from stored buckets so
    // a night that straddles the window edge still sees all of its data.
    const recent = await db.all(database,
      "SELECT id, wake_date, start_ts, end_ts FROM nights WHERE wake_date >= ?", localDate(sinceS - DAY_S, tz));
    let rhr = [];
    if (recent.length) {
      const lo = Math.min(...recent.map((n) => n.start_ts));
      const hi = Math.max(...recent.map((n) => n.end_ts));
      const stored = await db.all(database,
        "SELECT start_ts, avg FROM hr_buckets WHERE start_ts >= ? AND start_ts < ?", lo - 900, hi + 900);
      rhr = restingHrRows(recent, stored);
      await db.runStatements(database, db.upsertSql("rhr_daily", rhr));
    }

    Object.assign(counts, {
      hr_buckets: buckets.length, nights: nights.length, workouts: workouts.length,
      body: body.length, rhr_days: rhr.length, requests: counter.n,
    });
    meta.consecutive_failures = 0;
    meta.last_success = new Date().toISOString();
    meta.auth_ok = true;
  } catch (err) {
    if (err instanceof google.AuthError) {
      authFailed = true;
      meta.auth_ok = false;
    }
    error = String(err.message || err).slice(0, 300);
    meta.consecutive_failures = (meta.consecutive_failures || 0) + 1;
    console.error(`pull failed: ${error}`);
  }

  meta.last_run = new Date().toISOString();
  meta.last_status = error ? (authFailed ? "auth" : "error") : "ok";
  meta.last_counts = counts;
  meta.window_days = days;
  await db.putState(database, "meta", meta);
  await db.logSync(database, trigger, meta.last_status,
    error || `${days}-day window: ${counts.hr_buckets} HR buckets, ${counts.nights} sleep sessions, ${counts.workouts} workouts, ${counts.body} body readings`);

  // ---- alerts
  const lastDataAfter = await db.lastDataTs(database);
  const conditions = evaluateConditions({
    nowS, lastDataS: lastDataAfter, consecutiveFailures: meta.consecutive_failures, authFailed, settings,
  });
  if (!conditions.stale.active && lastDataBefore && lastDataAfter > lastDataBefore) {
    conditions.stale.payload.backfilled = Math.max(0, Math.floor((nowS - lastDataBefore) / DAY_S) - 1);
  }
  const notifier = buildNotifier(env);
  const { states, sent } = await processAlerts({
    conditions,
    states: await db.getAlertStates(database),
    settings,
    nowS,
    tz,
    // Evidence first: the alert is logged whatever the push service does.
    record: async (type, direction, payload) => {
      await db.logSync(database, "alert", `${type}:${direction}`, message(type, direction, payload).title);
    },
    notify: async (type, direction, payload) => {
      const m = message(type, direction, payload);
      try {
        await notifier.send(m.title, m.body);
        return true;
      } catch (err) {
        console.error(`notify ${type} ${direction}: ${err.message}`);
        return false;
      }
    },
  });
  await db.putState(database, "alerts", states);

  return { ok: !error, error, counts, window_days: days, sent };
}
