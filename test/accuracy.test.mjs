import test from "node:test";
import assert from "node:assert/strict";
import { localDateAt, localPartsAt, nightRow, offsetSeconds, stepsDailyRow, workoutRow } from "../src/ingest.js";
import {
  DEFAULT_TREND_BREAKS, badNight, circularSdMinutes, cleanBody, mainNights, mergeSplitNights, normaliseSettings,
  presentMeanSeries, restingHrRows, zone2,
} from "../src/metrics.js";

const TZ = "America/New_York";
const iso = (s) => Date.parse(s) / 1000;

test("a night abroad keeps its own clock: UTC+2 and UTC-5 nights get their local wake date", () => {
  // Europe, UTC+2: 23:30 to 07:10 local = 21:30Z to 05:10Z. In New York time it would end at 01:10 the day before.
  const europe = nightRow({
    name: "x/eu", dataSource: { application: { packageName: "com.sec.android.app.shealth" } },
    sleep: { interval: { startTime: "2026-05-11T21:30:00Z", endTime: "2026-05-12T05:10:00Z", startUtcOffset: "7200s", endUtcOffset: "7200s" }, stages: [] },
  }, TZ);
  assert.equal(europe.offset_s, 7200);
  assert.equal(europe.wake_date, "2026-05-12");
  assert.deepEqual(localPartsAt(europe.end_ts, europe.offset_s, TZ), { date: "2026-05-12", minutes: 7 * 60 + 10 });
  assert.deepEqual(localPartsAt(europe.start_ts, europe.offset_s, TZ), { date: "2026-05-11", minutes: 23 * 60 + 30 });

  // A UTC-5 zone in October: 23:45 to 06:30 local = 04:45Z to 11:30Z.
  const central = nightRow({
    name: "x/central", dataSource: {},
    sleep: { interval: { startTime: "2026-10-10T04:45:00Z", endTime: "2026-10-10T11:30:00Z", startUtcOffset: "-18000s", endUtcOffset: "-18000s" }, stages: [] },
  }, TZ);
  assert.equal(central.wake_date, "2026-10-10");
  assert.equal(localPartsAt(central.start_ts, central.offset_s, TZ).minutes, 23 * 60 + 45);
  // Without an offset the home zone applies (New York was UTC-4): 00:45, not 23:45.
  assert.equal(localPartsAt(central.start_ts, null, TZ).minutes, 45);

  const w = workoutRow({ name: "x/w", exercise: { interval: { startTime: "2026-05-11T22:30:00Z", endTime: "2026-05-11T23:00:00Z", startUtcOffset: "7200s" } } });
  assert.equal(localDateAt(w.start_ts, w.offset_s, TZ), "2026-05-12");
  assert.equal(offsetSeconds("-14400s"), -14400);
  assert.equal(offsetSeconds(undefined), null);
});

const session = (id, start, end, stages, extra = {}) => ({
  id, wake_date: "2026-09-10", start_ts: iso(start), end_ts: iso(end), offset_s: -14400, source: "s",
  deep_min: 0, rem_min: 0, light_min: (iso(end) - iso(start)) / 60, awake_min: 0, asleep_min: (iso(end) - iso(start)) / 60,
  stages_json: JSON.stringify(stages), ...extra,
});

test("split sessions within 120 minutes join into one night; the gap counts as awake", () => {
  const a = session("a", "2026-09-10T03:00:00Z", "2026-09-10T06:00:00Z", [[0, 180, "l"]]);
  const b = session("b", "2026-09-10T07:30:00Z", "2026-09-10T11:00:00Z", [[0, 210, "l"]]);
  const nap = session("nap", "2026-09-10T19:00:00Z", "2026-09-10T20:00:00Z", [[0, 60, "l"]]);
  const merged = mergeSplitNights([b, nap, a]);
  assert.equal(merged.length, 2);
  const night = mainNights([a, b, nap]).get("2026-09-10");
  assert.equal(night.parts, 2);
  assert.deepEqual(night.ids, ["a", "b"]);
  assert.equal(night.awake_min, 90);
  assert.equal(night.asleep_min, 390);
  assert.deepEqual(JSON.parse(night.stages_json), [[0, 180, "l"], [180, 90, "a"], [270, 210, "l"]]);
  // A gap longer than 120 minutes stays two sessions; the longer one is the main night.
  const c = session("c", "2026-09-10T08:01:00Z", "2026-09-10T12:00:00Z", [[0, 239, "l"]]);
  const two = mainNights([a, c]).get("2026-09-10");
  assert.equal(two.id, "c");
  // The joined night drives resting HR: buckets from both halves count.
  const buckets = [];
  for (let t = iso("2026-09-10T03:00:00Z"); t < iso("2026-09-10T11:00:00Z"); t += 900) buckets.push({ start_ts: t, avg: t < iso("2026-09-10T06:00:00Z") ? 60 : 50 });
  assert.equal(restingHrRows([a, b], buckets)[0].bpm, 50);
});

test("a 15-minute interior awakening marks a bad night; awake time at either end does not", () => {
  assert.equal(badNight([[0, 20, "a"], [20, 200, "l"], [220, 14, "a"], [234, 200, "l"], [434, 40, "a"]], 474).bad, false);
  const bad = badNight([[0, 200, "l"], [200, 15, "a"], [215, 200, "d"]], 415);
  assert.equal(bad.bad, true);
  assert.equal(bad.longest_awake_min, 15);
});

test("bedtime regularity is circular around midnight", () => {
  assert.ok(circularSdMinutes([23 * 60 + 50, 10, 0, 23 * 60 + 55]) < 15);
  assert.equal(circularSdMinutes([0, 10]), null);
  assert.ok(circularSdMinutes([22 * 60, 2 * 60, 0]) > 90);
});

test("Zone 2 is 60 to 70 percent of heart-rate reserve", () => {
  assert.deepEqual(zone2({ maxHr: 170, restHr: 50 }), { lo: 122, hi: 134, max_hr: 170, rest_hr: 50 });
  assert.equal(zone2({ maxHr: null, restHr: 50 }), null);
});

test("body cleanup: profile weights, Fitbit API mirrors, re-weighs and excluded dates", () => {
  const t = iso("2026-05-01T12:00:00Z");
  const out = cleanBody([
    { kind: "weight_g", ts: t, value: 80000, source: "com.qingniu.arboleaf", offset_s: -14400 },
    { kind: "weight_g", ts: t + 30, value: 80000, source: "FITBIT_WEB_API" },       // mirror: dropped
    { kind: "weight_g", ts: t + 600, value: 80200, source: "com.qingniu.arboleaf" }, // re-weigh within 30 min: replaces the first
    { kind: "weight_g", ts: t + 86400, value: 79000, source: "com.sec.android.app.shealth" }, // profile entry
    { kind: "weight_g", ts: t + 2 * 86400, value: 81000, source: "FITBIT_WEB_API" }, // no mirror: kept
    { kind: "weight_g", ts: iso("2026-05-20T14:00:00Z"), value: 82000, source: "com.qingniu.arboleaf" }, // excluded date
  ], { tz: TZ, excludedDates: ["2026-05-20"] });
  assert.deepEqual(out.scale.map((r) => [r.source, r.value]), [["com.qingniu.arboleaf", 80200], ["FITBIT_WEB_API", 81000]]);
  assert.equal(out.profile.length, 1);
  assert.deepEqual(out.dropped, { mirrored: 1, rewrites: 1, excluded: 1 });
});

test("Samsung daily steps: only Samsung Health day records, dated by their civil start date", () => {
  const dp = (pkg, count) => ({
    dataSource: { application: { packageName: pkg } },
    steps: { interval: { startTime: "2026-05-14T04:00:00Z", startUtcOffset: "-14400s", civilStartTime: { date: { year: 2026, month: 5, day: 14 } } }, count },
  });
  assert.deepEqual(stepsDailyRow(dp("com.sec.android.app.shealth", "6200"), TZ), { date: "2026-05-14", steps: 6200, source: "com.sec.android.app.shealth" });
  assert.equal(stepsDailyRow(dp("android", "900"), TZ), null);
});

test("steps averages skip missing days instead of counting them as zero", () => {
  const s = presentMeanSeries(new Map([["2026-05-04", 4000], ["2026-05-06", 6000]]), "2026-05-04", "2026-05-10", "week");
  assert.equal(s[s.length - 1].value, 5000);
  assert.equal(s[s.length - 1].n, 2);
  const d = presentMeanSeries(new Map([["2026-05-04", 4000]]), "2026-05-04", "2026-05-05", "day");
  assert.equal(d[1].value, null);
});

test("settings accept zone overrides and sleep bands, and reject nonsense", () => {
  const s = normaliseSettings({ zone_max_hr: "165", zone_rest_hr: "", sleep_bands: [85, 70, 50] });
  assert.equal(s.zone_max_hr, 165);
  assert.equal(s.zone_rest_hr, null);
  assert.deepEqual(s.sleep_bands, [85, 70, 50]);
  assert.deepEqual(normaliseSettings({ sleep_bands: [50, 70, 90] }).sleep_bands, [90, 70, 50]);
  assert.equal(normaliseSettings({ zone_max_hr: 400 }).zone_max_hr, null);
  assert.ok(Array.isArray(DEFAULT_TREND_BREAKS) && DEFAULT_TREND_BREAKS.every((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.date) && b.metric && b.note));
});
