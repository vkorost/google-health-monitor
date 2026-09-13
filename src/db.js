// D1 access. The upsert SQL builders are pure and shared with the backfill
// tool, so a row written by the cron and a row written by an import are the
// same statement.
//
// Writes use multi-row INSERT statements with literal values rather than one
// bound statement per row: a 14-day catch-up is ~1,350 heart-rate buckets, and
// one prepared statement per row would exceed the free plan's per-invocation
// query budget. Every value goes through sqlValue(), which only emits numbers,
// NULL, or single-quote-escaped strings.

import { normaliseSettings, ALERT_TYPES } from "./metrics.js";

export const TABLES = {
  hr_buckets: { key: ["start_ts"], cols: ["start_ts", "min", "avg", "max"] },
  nights: {
    key: ["id"],
    cols: ["id", "wake_date", "start_ts", "end_ts", "offset_s", "source", "deep_min", "rem_min", "light_min",
           "awake_min", "asleep_min", "stages_json", "updated_at"],
  },
  workouts: { key: ["id"], cols: ["id", "type", "name", "start_ts", "end_ts", "offset_s", "active_s", "avg_hr", "max_hr", "source"] },
  body: { key: ["id"], cols: ["id", "kind", "ts", "offset_s", "value", "source"] },
  rhr_daily: { key: ["date"], cols: ["date", "bpm", "night_id"] },
  steps_daily: { key: ["date"], cols: ["date", "steps", "source"] },
  samsung_nightly: {
    key: ["wake_date"],
    cols: ["wake_date", "sleep_score", "efficiency", "sleeping_hr", "sleeping_hrv", "skin_temp_delta",
           "respiratory_rate", "spo2_avg", "spo2_low_duration", "stress_avg", "source_note"],
  },
};

export function sqlValue(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * Upsert statements for `rows`, chunked so each statement stays under
 * maxBytes (D1 caps a statement at 100 KB).
 * max_hr on workouts is derived later, so an incoming NULL must not wipe it.
 */
export function upsertSql(table, rows, maxBytes = 90_000) {
  const t = TABLES[table];
  if (!t) throw new Error(`unknown table ${table}`);
  if (!rows.length) return [];
  const head = `INSERT INTO ${table} (${t.cols.join(", ")}) VALUES `;
  const update = t.cols
    .filter((c) => !t.key.includes(c))
    .map((c) => (table === "workouts" && c === "max_hr" ? `max_hr = COALESCE(excluded.max_hr, ${table}.max_hr)` : `${c} = excluded.${c}`))
    .join(", ");
  const tail = ` ON CONFLICT(${t.key.join(", ")}) DO UPDATE SET ${update};`;
  const out = [];
  let parts = [], size = head.length + tail.length;
  for (const r of rows) {
    const tuple = `(${t.cols.map((c) => sqlValue(r[c])).join(", ")})`;
    if (parts.length && size + tuple.length + 2 > maxBytes) {
      out.push(head + parts.join(",\n") + tail);
      parts = []; size = head.length + tail.length;
    }
    parts.push(tuple);
    size += tuple.length + 2;
  }
  if (parts.length) out.push(head + parts.join(",\n") + tail);
  return out;
}

/** Workout max HR from stored buckets overlapping the session. */
export function workoutMaxHrSql(sinceS) {
  return `UPDATE workouts SET max_hr = (SELECT MAX(b.max) FROM hr_buckets b
    WHERE b.start_ts >= workouts.start_ts - 900 AND b.start_ts < workouts.end_ts)
    WHERE start_ts >= ${Number(sinceS) | 0}
      AND EXISTS (SELECT 1 FROM hr_buckets b WHERE b.start_ts >= workouts.start_ts - 900 AND b.start_ts < workouts.end_ts);`;
}

export async function runStatements(database, statements) {
  if (!statements.length) return;
  // D1 batch runs as one transaction: a failed chunk leaves no half-written run.
  await database.batch(statements.map((s) => database.prepare(s)));
}

// ------------------------------------------------------------ state

export async function getState(database, key, fallback = null) {
  const row = await database.prepare("SELECT value FROM state WHERE key = ?").bind(key).first();
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

export async function putState(database, key, value) {
  await database
    .prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, JSON.stringify(value))
    .run();
}

export async function getSettings(database) {
  return normaliseSettings(await getState(database, "settings", {}));
}

export async function setSettings(database, patch) {
  const cur = await getState(database, "settings", {});
  const next = normaliseSettings({ ...cur, ...(patch || {}) });
  await putState(database, "settings", next);
  return next;
}

export async function getAlertStates(database) {
  const s = await getState(database, "alerts", {});
  return Object.fromEntries(ALERT_TYPES.map((t) => [t, s[t] || {}]));
}

export async function logSync(database, trigger, status, detail) {
  await database
    .prepare("INSERT INTO sync_log (ts, trigger, status, detail) VALUES (?, ?, ?, ?)")
    .bind(new Date().toISOString(), trigger, status, typeof detail === "string" ? detail : JSON.stringify(detail))
    .run();
}

// ------------------------------------------------------------ reads

export async function all(database, sql, ...binds) {
  const { results } = await database.prepare(sql).bind(...binds).all();
  return results || [];
}

export async function first(database, sql, ...binds) {
  return database.prepare(sql).bind(...binds).first();
}

/** Newest evidence that the watch pipeline is alive, epoch seconds or null. */
export async function lastDataTs(database) {
  const r = await first(
    database,
    `SELECT MAX(x) AS t FROM (
       SELECT MAX(start_ts) + 900 AS x FROM hr_buckets
       UNION ALL SELECT MAX(end_ts) AS x FROM nights)`
  );
  return r?.t ?? null;
}

export async function prune(database) {
  // Rollups and sessions are the record and are never pruned. Only the sync
  // log grows without bound, so keep a year of it.
  const cutoff = new Date(Date.now() - 365 * 86400_000).toISOString();
  await database.prepare("DELETE FROM sync_log WHERE ts < ?").bind(cutoff).run();
}
