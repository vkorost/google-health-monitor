// The heart-rate coverage calendar, kept as a counted map in state instead of
// an aggregate over hr_buckets.
//
// Counting with SQL meant one full-table scan (about 30,000 rows) for every
// Data health load. D1's free plan allows 5 million rows read a day across the
// whole account, and that single query was most of this app's share of it.
// Each pull now recounts only the days its window touched, and the calendar
// reads one state row.

import * as db from "./db.js";
import { addDays, localDate, localMidnight } from "./ingest.js";
import { COVERAGE_KEEP_DAYS, coverageCounts, mergeCoverage } from "./metrics.js";

const KEY = "hr_coverage";

/** Bucket counts per local date for every day from `fromDate` on. Whole days only, so a count is never partial. */
async function recountFrom(database, tz, fromDate) {
  const rows = await db.all(database, "SELECT start_ts FROM hr_buckets WHERE start_ts >= ?", localMidnight(fromDate, tz));
  return coverageCounts(rows.map((r) => r.start_ts), (ts) => localDate(ts, tz));
}

/**
 * After a pull: recount the days the pull window covered and merge them in.
 * A 14-day catch-up window reads about 1,350 rows, a normal 3-day window 290.
 */
export async function refreshCoverage(database, tz, windowStartS, nowS) {
  const freshFrom = localDate(windowStartS, tz);
  const fresh = await recountFrom(database, tz, freshFrom);
  const keepFrom = addDays(localDate(nowS, tz), -COVERAGE_KEEP_DAYS);
  const next = mergeCoverage(await db.getState(database, KEY, null), fresh, freshFrom, keepFrom);
  await db.putState(database, KEY, next);
  return next;
}

/**
 * Counts for the calendar. The stored map is used when it reaches back to
 * `from`; otherwise it is rebuilt once from the buckets themselves, which also
 * covers a fresh deployment and an import that added older days. An import
 * clears the key (see tools/samsung_import.py) so the rebuild picks its data up.
 */
export async function coverageDays(database, tz, from) {
  const stored = await db.getState(database, KEY, null);
  if (stored && stored.days && stored.from && stored.from <= from) return stored.days;
  const days = await recountFrom(database, tz, from);
  await db.putState(database, KEY, { from, days });
  return days;
}
