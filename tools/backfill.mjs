// History import for Health Monitor. Runs locally (no Worker CPU or
// subrequest limits), pulls from the Google Health API with the same
// ingest/metrics code the Worker uses, and writes SQL files for:
//
//   npx wrangler d1 execute healthmon --remote --file=import/NN-name.sql
//
// It never writes to D1 itself.
//
//   node tools/backfill.mjs              12 months of 15-min heart rate + all summaries
//   node tools/backfill.mjs --hr-days 90
//   node tools/backfill.mjs --steps-days 730   Samsung daily step totals (one API request per day)
//
// Reads .secrets/client_secret.json (web client) and .secrets/token.json.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as google from "../src/google.js";
import { addDays, bodyRow, bucketRows, isoOf, localDate, localMidnight, nightRow, stepsDailyRow, workoutRow } from "../src/ingest.js";
import { restingHrRows } from "../src/metrics.js";
import { upsertSql, workoutMaxHrSql } from "../src/db.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "import");
// Set HEALTH_TZ to the same IANA zone as the TZ var in wrangler.jsonc.
const TZ = process.env.HEALTH_TZ || "America/New_York";
const DAY_S = 86400;

// D1 counts index maintenance as extra written rows, so budget per table.
const WRITES_PER_ROW = { hr_buckets: 1, nights: 2, workouts: 2, body: 2, rhr_daily: 2, steps_daily: 1 };
const MAX_WRITES_PER_FILE = 80_000;
const MAX_BYTES_PER_FILE = 4_500_000;

const args = process.argv.slice(2);
const hrDays = Number(args[args.indexOf("--hr-days") + 1]) || 365;
const stepsDays = args.includes("--steps-days") ? Number(args[args.indexOf("--steps-days") + 1]) || 0 : 730;

function secrets() {
  const client = JSON.parse(readFileSync(join(ROOT, ".secrets", "client_secret.json"), "utf8"));
  const c = client.web || client.installed;
  const tok = JSON.parse(readFileSync(join(ROOT, ".secrets", "token.json"), "utf8"));
  return { clientId: c.client_id, clientSecret: c.client_secret, refreshToken: tok.refresh_token };
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function main() {
  const token = await google.accessToken(secrets());
  log("token ok");
  // Align to 15 minutes: rollUp windows start at the range start, and the
  // Worker's buckets must land on the same start_ts values.
  const nowS = Math.floor(Date.now() / 1000 / 900) * 900;

  // ---- heart rate: rollUp in 14-day windows (the API maximum)
  const buckets = [];
  const hrStart = nowS - hrDays * DAY_S;
  for (let s = hrStart; s < nowS; s += 14 * DAY_S) {
    const e = Math.min(nowS, s + 14 * DAY_S);
    const got = bucketRows(await google.rollUp(token, "heart-rate", isoOf(s), isoOf(e)));
    buckets.push(...got);
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  const byStart = new Map(buckets.map((b) => [b.start_ts, b]));
  const hr = [...byStart.values()].sort((a, b) => a.start_ts - b.start_ts);
  log(`heart-rate buckets: ${hr.length}`);

  // ---- sessions and readings: full history, newest first
  const sleepPts = await google.listPoints(token, "sleep", { pageSize: 25, maxPages: 1000 });
  const nights = sleepPts.map((p) => nightRow(p, TZ)).filter(Boolean);
  log(`sleep sessions: ${nights.length}`);

  const exPts = await google.listPoints(token, "exercise", { pageSize: 25, maxPages: 1000 });
  const workouts = exPts.map(workoutRow).filter(Boolean);
  log(`workouts: ${workouts.length}`);

  const weight = (await google.listPoints(token, "weight", { pageSize: 1000, maxPages: 100 })).map((p) => bodyRow(p, "weight_g"));
  const fat = (await google.listPoints(token, "body-fat", { pageSize: 1000, maxPages: 100 })).map((p) => bodyRow(p, "fat_pct"));
  const body = [...weight, ...fat].filter(Boolean);
  log(`body readings: ${body.length} (weight ${weight.length}, body fat ${fat.length})`);

  // ---- Samsung daily steps: a one-second filter at each local midnight skips the per-minute phone records
  const steps = [];
  const today = localDate(nowS, TZ);
  for (let i = 0; i < stepsDays; i++) {
    const t0 = localMidnight(addDays(today, -i), TZ);
    const pts = await google.listPoints(token, "steps", {
      filter: `steps.interval.start_time >= "${isoOf(t0)}" AND steps.interval.start_time < "${isoOf(t0 + 1)}"`, pageSize: 20, maxPages: 1,
    });
    for (const p of pts) { const r = stepsDailyRow(p, TZ); if (r) steps.push(r); }
    if (i % 30 === 29) process.stdout.write(".");
  }
  process.stdout.write("\n");
  log(`Samsung step days: ${steps.length} of ${stepsDays}`);

  // ---- derived
  const rhr = restingHrRows(nights, hr);
  log(`resting HR days: ${rhr.length}`);
  for (const w of workouts) {
    let max = null;
    for (let t = Math.floor((w.start_ts - 900) / 900) * 900; t < w.end_ts; t += 900) {
      const b = byStart.get(t);
      if (b && b.start_ts >= w.start_ts - 900 && (max === null || b.max > max)) max = b.max;
    }
    w.max_hr = max;
  }

  // ---- write files
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const files = [];
  let buf = [], writes = 0, bytes = 0, part = 1;
  const flush = (label) => {
    if (!buf.length) return;
    const name = `${String(part).padStart(2, "0")}-${label}.sql`;
    writeFileSync(join(OUT, name), buf.join("\n") + "\n");
    files.push({ name, writes, bytes });
    part++; buf = []; writes = 0; bytes = 0;
  };
  const add = (table, rows) => {
    // Re-chunk rows so a single file never exceeds either budget.
    const perRow = WRITES_PER_ROW[table];
    const batch = Math.max(1, Math.floor(MAX_WRITES_PER_FILE / perRow));
    for (let i = 0; i < rows.length; i += batch) {
      for (const stmt of upsertSql(table, rows.slice(i, i + batch))) {
        const n = (stmt.match(/\),\n\(/g) || []).length + 1;
        if (buf.length && (writes + n * perRow > MAX_WRITES_PER_FILE || bytes + stmt.length > MAX_BYTES_PER_FILE)) flush(table);
        buf.push(stmt); writes += n * perRow; bytes += stmt.length + 1;
      }
    }
    flush(table);
  };
  add("hr_buckets", hr);
  add("nights", nights);
  add("workouts", workouts);
  add("body", body);
  add("rhr_daily", rhr);
  add("steps_daily", steps);
  buf.push(workoutMaxHrSql(0)); writes += workouts.length * 2; bytes += 300;
  flush("workout-max-hr");

  const total = files.reduce((n, f) => n + f.writes, 0);
  console.log("\nTable counts:");
  console.table({ hr_buckets: hr.length, nights: nights.length, workouts: workouts.length, body: body.length, rhr_daily: rhr.length, steps_daily: steps.length });
  console.log("Files (import in order):");
  for (const f of files) console.log(`  import/${f.name}  ${(f.bytes / 1024).toFixed(0)} KB  ~${f.writes} row writes`);
  console.log(`Estimated row writes in total: ~${total} (D1 free plan: 100,000 per day)`);
  const oldestNight = nights.reduce((m, n) => (n.wake_date < m ? n.wake_date : m), "9999");
  console.log(`Oldest night: ${oldestNight}; HR buckets from ${hr.length ? isoOf(hr[0].start_ts) : "n/a"}`);
}

main().catch((err) => {
  console.error(`backfill failed: ${err.message}`);
  process.exit(1);
});
