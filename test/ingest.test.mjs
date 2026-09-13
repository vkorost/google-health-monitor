import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays, bodyRow, bucketRows, compactStages, exerciseCategory, localDate, localMidnight,
  localParts, nightRow, stageTotals, workoutRow,
} from "../src/ingest.js";

const TZ = "America/New_York";

test("stages are sorted, merged and totalled", () => {
  const start = Date.parse("2026-09-12T03:00:00Z") / 1000;
  const stages = [
    { startTime: "2026-09-12T03:20:00Z", endTime: "2026-09-12T03:50:00Z", type: "DEEP" },
    { startTime: "2026-09-12T03:00:00Z", endTime: "2026-09-12T03:10:00Z", type: "LIGHT" },
    { startTime: "2026-09-12T03:10:00Z", endTime: "2026-09-12T03:20:00Z", type: "LIGHT" },
    { startTime: "2026-09-12T03:50:00Z", endTime: "2026-09-12T03:52:30Z", type: "AWAKE" },
    { startTime: "2026-09-12T03:52:30Z", endTime: "2026-09-12T04:10:00Z", type: "REM" },
    { startTime: "2026-09-12T04:10:00Z", endTime: "2026-09-12T04:15:00Z", type: "WEIRD_NEW_TYPE" },
  ];
  const c = compactStages(stages, start);
  assert.deepEqual(c, [[0, 20, "l"], [20, 30, "d"], [50, 2.5, "a"], [52.5, 17.5, "r"]]);
  assert.deepEqual(stageTotals(c), { deep_min: 30, rem_min: 17.5, light_min: 20, awake_min: 2.5, asleep_min: 67.5 });
});

test("wake_date is the local date of the end, across midnight and DST", () => {
  // 11:30 PM EDT on Sep 11 is 03:30 UTC Sep 12: still the 11th locally.
  assert.equal(localDate(Date.parse("2026-09-12T03:30:00Z") / 1000, TZ), "2026-09-11");
  // 12:30 AM EDT on Sep 12.
  assert.equal(localDate(Date.parse("2026-09-12T04:30:00Z") / 1000, TZ), "2026-09-12");
  // DST ends 2026-11-01 at 2 AM EDT -> 1 AM EST. 05:30 UTC is 00:30 EST on Nov 1.
  assert.equal(localDate(Date.parse("2026-11-01T05:30:00Z") / 1000, TZ), "2026-11-01");
  assert.equal(localParts(Date.parse("2026-11-01T06:30:00Z") / 1000, TZ).minutes, 90); // 1:30 AM EST
  const night = nightRow({
    name: "users/1/dataTypes/sleep/dataPoints/42",
    dataSource: { application: { packageName: "com.sec.android.app.shealth" } },
    sleep: { interval: { startTime: "2026-11-01T03:00:00Z", endTime: "2026-11-01T12:00:00Z" }, stages: [] },
  }, TZ);
  assert.equal(night.wake_date, "2026-11-01");
  assert.equal(night.id, "42");
  assert.equal(night.source, "com.sec.android.app.shealth");
  assert.equal(night.asleep_min, 540); // no stage detail: whole session counts as asleep
  assert.equal(night.stages_json, "[]");
});

test("local midnight is correct on both DST transition days", () => {
  assert.equal(localMidnight("2026-09-12", TZ), Date.parse("2026-09-12T04:00:00Z") / 1000);
  assert.equal(localMidnight("2026-11-01", TZ), Date.parse("2026-11-01T04:00:00Z") / 1000); // still EDT at midnight
  assert.equal(localMidnight("2026-11-02", TZ), Date.parse("2026-11-02T05:00:00Z") / 1000);
  assert.equal(localMidnight("2026-03-08", TZ), Date.parse("2026-03-08T05:00:00Z") / 1000);
  assert.equal(localMidnight("2026-03-09", TZ), Date.parse("2026-03-09T04:00:00Z") / 1000);
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
});

test("rollUp buckets, workouts and body readings map to rows", () => {
  const b = bucketRows([
    { startTime: "2026-09-12T03:45:00Z", heartRate: { beatsPerMinuteAvg: 58.26, beatsPerMinuteMax: 64, beatsPerMinuteMin: 52 } },
    { startTime: "2026-09-12T03:30:00Z", heartRate: { beatsPerMinuteAvg: 57.1, beatsPerMinuteMax: 61, beatsPerMinuteMin: 53 } },
    { startTime: "2026-09-12T04:00:00Z", heartRate: {} },
  ]);
  assert.equal(b.length, 2);
  assert.equal(b[0].start_ts, Date.parse("2026-09-12T03:30:00Z") / 1000);
  assert.equal(b[1].avg, 58.3);

  const w = workoutRow({
    name: "x/1000000000000000001",
    dataSource: { application: { packageName: "com.sec.android.app.shealth" } },
    exercise: {
      interval: { startTime: "2026-03-15T17:00:00.250Z", endTime: "2026-03-15T17:20:00.750Z" },
      exerciseType: "SWIMMING", displayName: "Swim", activeDuration: "1100.500s",
      metricsSummary: { averageHeartRateBeatsPerMinute: "120" },
    },
  });
  assert.equal(w.active_s, 1100.5);
  assert.equal(w.avg_hr, 120);
  assert.equal(exerciseCategory(w.type), "Swimming");
  assert.equal(exerciseCategory("BIKING_STATIONARY"), "Biking");
  assert.equal(exerciseCategory("OUTDOOR_BIKE"), "Biking");
  assert.equal(exerciseCategory("SPINNING"), "Biking");
  assert.equal(exerciseCategory("WALKING"), "Other");
  assert.equal(exerciseCategory("STRENGTH_TRAINING"), "Other");

  const wt = bodyRow({ name: "a/9", dataSource: { application: { packageName: "com.qingniu.arboleaf" } },
    weight: { sampleTime: { physicalTime: "2026-03-15T12:00:00Z" }, weightGrams: 75000 } }, "weight_g");
  assert.deepEqual(wt, { id: "w:9", kind: "weight_g", ts: 1773576000, value: 75000, offset_s: null, source: "com.qingniu.arboleaf" });
  assert.equal(bodyRow({ name: "a/9", bodyFat: { sampleTime: { physicalTime: "2026-03-15T12:00:00Z" }, percentage: 20.5 } }, "fat_pct").id, "f:9");
});

test("cached offsets agree with Intl for every hour across both 2026 DST changes", () => {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (const [from, to] of [["2026-03-07T00:00:00Z", "2026-03-10T00:00:00Z"], ["2026-10-31T00:00:00Z", "2026-11-03T00:00:00Z"], ["2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z"]]) {
    for (let t = Date.parse(from) / 1000; t < Date.parse(to) / 1000; t += 1800) {
      const p = Object.fromEntries(fmt.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
      const want = { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
      assert.deepEqual(localParts(t, TZ), want, new Date(t * 1000).toISOString());
    }
  }
});
