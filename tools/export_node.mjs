// Sleep and workout derivations for the dataset export, run by tools/export_dataset.py.
// Uses the Worker's own ingest.js and metrics.js so the dataset and the dashboard share
// one definition of a night, a sleep score, a duplicate workout and a merged ride.
//
//   node tools/export_node.mjs <raw_dir> <out_dir> <tz>

import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { exerciseCategory, isoOf, localParts, nightRow, workoutRow } from "../src/ingest.js";
import { dropDuplicateWorkouts, mainNights, mergeWorkouts, sleepScore } from "../src/metrics.js";

const [rawDir, outDir, tz = "America/New_York"] = process.argv.slice(2);
const readNdjson = (name) => gunzipSync(readFileSync(join(rawDir, name))).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const local = (s) => { const p = localParts(s, tz); return `${p.date} ${String(Math.floor(p.minutes / 60)).padStart(2, "0")}:${String(p.minutes % 60).padStart(2, "0")}`; };
const CODE_NAME = { d: "deep", r: "rem", l: "light", a: "awake", s: "asleep_unstaged" };

// ---- sleep
const nights = readNdjson("sleep.ndjson.gz").map((dp) => nightRow(dp, tz)).filter(Boolean);
const mains = new Set([...mainNights(nights).values()].map((n) => n.id));
const sessions = [], stages = [];
for (const n of nights) {
  const compact = JSON.parse(n.stages_json || "[]");
  const inBed = (n.end_ts - n.start_ts) / 60;
  const sc = sleepScore(compact, inBed);
  sessions.push({
    id: n.id, source: n.source, wake_date: n.wake_date, is_main_night: mains.has(n.id) ? 1 : 0,
    start_utc: isoOf(n.start_ts), end_utc: isoOf(n.end_ts), start_local: local(n.start_ts), end_local: local(n.end_ts),
    in_bed_min: Math.round(inBed * 10) / 10, asleep_min: n.asleep_min, deep_min: n.deep_min, rem_min: n.rem_min,
    light_min: n.light_min, awake_min: n.awake_min, has_stages: compact.some((s) => s[2] !== "s") ? 1 : 0,
    sleep_score: sc?.score ?? null, sleep_label: sc?.label ?? null,
    efficiency_pct: sc?.facts.efficiency ?? null, deep_pct: sc?.facts.deep_pct ?? null, rem_pct: sc?.facts.rem_pct ?? null,
    awake_after_onset_min: sc?.facts.waso_min ?? null, wakeups: sc?.facts.wakeups ?? null, cycles: sc?.facts.cycles ?? null,
  });
  for (const [off, len, code] of compact) {
    const s = n.start_ts + Math.round(off * 60);
    stages.push({ session_id: n.id, stage: CODE_NAME[code] || code, start_utc: isoOf(s), end_utc: isoOf(s + Math.round(len * 60)), start_local: local(s), minutes: len });
  }
}

// ---- workouts: raw rows plus the dashboard's combined view
const raw = readNdjson("exercise.ndjson.gz").map((dp) => {
  const w = workoutRow(dp);
  return w && { ...w, category: exerciseCategory(w.type) };
}).filter(Boolean);
const kept = new Set(dropDuplicateWorkouts(raw).map((w) => w.id));
const combined = mergeWorkouts(dropDuplicateWorkouts(raw)).map((w) => ({
  first_id: w.id, source: w.source, category: w.category, type: w.type, name: w.name, segments: w.parts,
  start_utc: isoOf(w.start_ts), end_utc: isoOf(w.end_ts), start_local: local(w.start_ts), local_date: localParts(w.start_ts, tz).date,
  elapsed_min: Math.round((w.end_ts - w.start_ts) / 6) / 10, active_min: Math.round(w.active_s / 6) / 10,
  avg_hr_reported: w.avg_hr,
}));
const workoutFlags = raw.map((w) => ({ id: w.id, category: w.category, hidden_as_duplicate: kept.has(w.id) ? 0 : 1 }));

writeFileSync(join(outDir, "sleep_sessions.json"), JSON.stringify(sessions));
writeFileSync(join(outDir, "sleep_stages.json"), JSON.stringify(stages));
writeFileSync(join(outDir, "workouts_combined.json"), JSON.stringify(combined));
writeFileSync(join(outDir, "workout_flags.json"), JSON.stringify(workoutFlags));
console.log(JSON.stringify({ sessions: sessions.length, stages: stages.length, workouts_raw: raw.length, workouts_combined: combined.length }));
