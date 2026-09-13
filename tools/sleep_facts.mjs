// Sleep facts and scores computed by the Worker's own metrics.js, for tools/fit_sleep_score.py.
//
//   node tools/sleep_facts.mjs export <in.json> <out.json>        in: [{key, stages, in_bed_min}]
//   node tools/sleep_facts.mjs google <sleep.ndjson.gz> <out.json> <tz>
//     main nights (split sessions joined) from a Google Health API sleep dump, keyed by wake_date
//
// Output rows: {key, facts, score}. `score` uses the SLEEP_MODEL currently in metrics.js.

import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { nightRow } from "../src/ingest.js";
import { mainNights, sleepFacts, sleepScore } from "../src/metrics.js";

const [mode, input, output, tz = "America/New_York"] = process.argv.slice(2);
let rows;
if (mode === "export") {
  rows = JSON.parse(readFileSync(input, "utf8")).map((r) => ({ key: r.key, stages: r.stages, in_bed_min: r.in_bed_min }));
} else if (mode === "google") {
  const lines = gunzipSync(readFileSync(input)).toString("utf8").split("\n").filter(Boolean);
  const nights = lines.map((l) => nightRow(JSON.parse(l), tz)).filter(Boolean);
  rows = [...mainNights(nights).values()].map((n) => ({
    key: n.wake_date, stages: JSON.parse(n.stages_json || "[]"), in_bed_min: (n.end_ts - n.start_ts) / 60,
    start_s: n.start_ts, end_s: n.end_ts, source: n.source,
  }));
} else {
  throw new Error("mode must be export or google");
}
const out = rows.map((r) => {
  const f = sleepFacts(r.stages, r.in_bed_min);
  const sc = sleepScore(r.stages, r.in_bed_min);
  return { key: r.key, start_s: r.start_s, end_s: r.end_s, source: r.source, facts: f, score: sc ? sc.score : null };
});
writeFileSync(output, JSON.stringify(out));
console.log(`${out.length} nights, ${out.filter((r) => r.facts).length} with facts`);
