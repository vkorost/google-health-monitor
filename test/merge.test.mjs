import test from "node:test";
import assert from "node:assert/strict";
import { mergeWorkouts } from "../src/metrics.js";

const w = (start, end, category, avg, max, active) => ({ id: String(start), start_ts: start, end_ts: end, category, avg_hr: avg, max_hr: max, active_s: active ?? end - start });

test("ride split at traffic lights becomes one workout", () => {
  const out = mergeWorkouts([
    w(0, 1800, "Biking", 100, 120),
    w(1860, 2460, "Biking", 130, 150),   // 1 minute stop
    w(2820, 3120, "Biking", 110, 125),   // 6 minute stop
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].parts, 3);
  assert.equal(out[0].start_ts, 0);
  assert.equal(out[0].end_ts, 3120);
  assert.equal(out[0].active_s, 1800 + 600 + 300);
  assert.equal(out[0].max_hr, 150);
  assert.equal(out[0].avg_hr, Math.round(((100 * 1800 + 130 * 600 + 110 * 300) / 2700) * 10) / 10);
});

test("a long gap or a different type starts a new workout", () => {
  const out = mergeWorkouts([
    w(0, 1800, "Biking", 100, 120),
    w(1800 + 601, 3000, "Biking", 100, 120),
    w(3060, 3600, "Swimming", 110, 130),
  ]);
  assert.deepEqual(out.map((x) => [x.category, x.parts]), [["Biking", 1], ["Biking", 1], ["Swimming", 1]]);
});

test("missing heart rate does not drag the average down", () => {
  const out = mergeWorkouts([w(0, 600, "Biking", 120, 140), w(660, 1260, "Biking", null, null)]);
  assert.equal(out[0].avg_hr, 120);
  assert.equal(out[0].max_hr, 140);
});

import { dropDuplicateWorkouts } from "../src/metrics.js";

test("a Polar ride replaces the Samsung segments of the same ride", () => {
  const polar = { id: "p", source: "fi.polar.polarflow", category: "Biking", start_ts: 0, end_ts: 7200 };
  const segs = [[5, 1800], [1840, 2480], [2500, 3900], [4000, 7180]].map(([a, b], i) =>
    ({ id: "s" + i, source: "com.sec.android.app.shealth", category: "Biking", start_ts: a, end_ts: b }));
  const swim = { id: "w", source: "com.sec.android.app.shealth", category: "Swimming", start_ts: 9000, end_ts: 9900 };
  const out = dropDuplicateWorkouts([...segs, swim, polar]);
  assert.deepEqual(out.map((w) => w.id), ["p", "w"]);
});

test("a Samsung workout next to, not inside, a Polar one is kept", () => {
  const out = dropDuplicateWorkouts([
    { id: "p", source: "fi.polar.polarflow", category: "Biking", start_ts: 0, end_ts: 3600 },
    { id: "s", source: "com.sec.android.app.shealth", category: "Biking", start_ts: 3500, end_ts: 5400 },
  ]);
  assert.equal(out.length, 2);
});
