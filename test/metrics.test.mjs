import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS, averageSeries, dedupeBody, evaluateConditions, exerciseSeries, inQuietHours,
  mainNights, normaliseSettings, periods, processAlerts, rangeSpec, restingHr, restingHrRows,
  rollingMedian, sleepSeries, trailingMean,
} from "../src/metrics.js";

const TZ = "America/New_York";
const T0 = Date.parse("2026-09-12T04:00:00Z") / 1000; // midnight EDT

const bucket = (i, avg) => ({ start_ts: T0 + i * 900, min: avg - 3, avg, max: avg + 4 });

test("resting HR is the lowest pair of consecutive buckets inside the night", () => {
  const b = [bucket(0, 60), bucket(1, 56), bucket(2, 54), bucket(3, 58), bucket(4, 62)];
  assert.equal(restingHr(b, T0, T0 + 5 * 900), 55); // (56 + 54) / 2
  // Buckets outside the night do not count.
  assert.equal(restingHr([...b, bucket(20, 40), bucket(21, 40)], T0, T0 + 5 * 900), 55);
});

test("a missing bucket breaks the pair instead of bridging it", () => {
  const b = [bucket(0, 60), bucket(1, 50), /* 2 missing */ bucket(3, 50), bucket(4, 64)];
  // Only valid pairs are (0,1)=55 and (3,4)=57; 50 and 50 across the gap must not form 50.
  assert.equal(restingHr(b, T0, T0 + 5 * 900), 55);
  assert.equal(restingHr([bucket(0, 50)], T0, T0 + 900), null);
  assert.equal(restingHr([], T0, T0 + 900), null);
});

test("main night is the longest session per wake date; RHR rows follow it", () => {
  const nights = [
    { id: "nap", wake_date: "2026-09-12", start_ts: T0 + 13 * 3600, end_ts: T0 + 14 * 3600 },
    { id: "night", wake_date: "2026-09-12", start_ts: T0, end_ts: T0 + 5 * 900 },
  ];
  assert.equal(mainNights(nights).get("2026-09-12").id, "night");
  const rows = restingHrRows(nights, [bucket(0, 60), bucket(1, 52), bucket(2, 54)]);
  assert.deepEqual(rows, [{ date: "2026-09-12", bpm: 53, night_id: "night" }]);
});

test("duplicate weigh-ins are dropped, distinct ones kept; median uses 7 days", () => {
  const w = (ts, value) => ({ kind: "weight_g", ts, value, source: "com.qingniu.arboleaf" });
  const day = 86400;
  const raw = [w(T0, 75000), w(T0 + 38, 75000), w(T0 + 60, 75250), w(T0 + 2 * day, 74500), w(T0 + 9 * day, 73000)];
  const d = dedupeBody(raw);
  assert.equal(d.length, 4);
  const m = rollingMedian(d, 7);
  assert.equal(m[0].median, 75000);
  assert.equal(m[1].median, (75000 + 75250) / 2);
  assert.equal(m[2].median, 75000); // 75000, 75250, 74500
  assert.equal(m[3].median, 73000); // older readings fell out of the window
});

test("periods and downsampling", () => {
  assert.equal(periods("2026-09-06", "2026-09-12", "day").length, 7);
  const weeks = periods("2026-08-17", "2026-09-12", "week");
  assert.equal(weeks[weeks.length - 1].b, "2026-09-12");
  assert.equal(weeks[weeks.length - 1].a, "2026-09-06");
  assert.equal(weeks[0].a, "2026-08-17"); // clipped to range start
  const months = periods("2026-07-15", "2026-09-12", "month");
  assert.deepEqual(months.map((p) => p.key), ["2026-07", "2026-08", "2026-09"]);
  assert.equal(months[0].a, "2026-07-15");
  assert.equal(months[2].b, "2026-09-12");

  const spec = rangeSpec("1y", "2026-09-12");
  assert.equal(spec.grain, "week");
  assert.equal(rangeSpec("all", "2026-09-12", "2018-03-01").from, "2018-03-01");

  const nights = new Map([
    ["2026-09-11", { deep_min: 60, rem_min: 90, light_min: 240, awake_min: 10, asleep_min: 390 }],
    ["2026-09-12", { deep_min: 80, rem_min: 100, light_min: 260, awake_min: 20, asleep_min: 440 }],
  ]);
  const s = sleepSeries(nights, "2026-09-06", "2026-09-12", "week");
  assert.equal(s.length, 1);
  assert.equal(s[0].n, 2);
  assert.equal(s[0].v.asleep, 415);
  assert.equal(sleepSeries(nights, "2026-09-10", "2026-09-12", "day")[0].v, null);

  const rhr = new Map([["2026-09-11", 55], ["2026-09-12", 57]]);
  assert.equal(averageSeries(rhr, "2026-09-06", "2026-09-12", "week")[0].value, 56);
  assert.equal(trailingMean(rhr, ["2026-09-12"], 30)[0].value, 56);

  const ex = exerciseSeries([
    { date: "2026-09-12", category: "Biking", minutes: 75 },
    { date: "2026-09-12", category: "Swimming", minutes: 24.6 },
  ], "2026-09-12", "2026-09-12", "day");
  assert.deepEqual(ex[0].v, { Swimming: 25, Biking: 75, Other: 0 });
});

// ------------------------------------------------------------ alerts

const at = (iso) => Date.parse(iso) / 1000;
const NOON = at("2026-09-12T16:00:00Z"); // 12:00 EDT
const NIGHT = at("2026-09-13T03:00:00Z"); // 23:00 EDT, quiet hours
const settings = normaliseSettings({});

function harness({ failSends = false } = {}) {
  const records = [], sends = [];
  return {
    records, sends,
    record: async (type, direction) => { records.push(`${type}:${direction}`); },
    notify: async (type, direction) => { sends.push(`${type}:${direction}`); return !failSends; },
  };
}
const cond = (over) => ({
  stale: { active: false, payload: {} }, failing: { active: false, payload: {} }, auth: { active: false, payload: {} }, ...over,
});

test("stale fires once and recovers once", async () => {
  const h = harness();
  let states = {};
  for (let i = 0; i < 3; i++) {
    ({ states } = await processAlerts({ conditions: cond({ stale: { active: true, payload: { days: 3 } } }), states, settings, nowS: NOON, tz: TZ, record: h.record, notify: h.notify }));
  }
  assert.deepEqual(h.records, ["stale:fire"]);
  assert.deepEqual(h.sends, ["stale:fire"]);
  for (let i = 0; i < 2; i++) {
    ({ states } = await processAlerts({ conditions: cond({}), states, settings, nowS: NOON, tz: TZ, record: h.record, notify: h.notify }));
  }
  assert.deepEqual(h.records, ["stale:fire", "stale:recover"]);
  assert.deepEqual(h.sends, ["stale:fire", "stale:recover"]);
});

test("quiet hours hold delivery, then the next run delivers", async () => {
  const h = harness();
  let { states, sent } = await processAlerts({ conditions: cond({ stale: { active: true, payload: {} } }), states: {}, settings, nowS: NIGHT, tz: TZ, record: h.record, notify: h.notify });
  assert.deepEqual(h.records, ["stale:fire"]);
  assert.deepEqual(h.sends, []);
  assert.equal(states.stale.pending, true);
  assert.equal(sent.length, 0);
  ({ states, sent } = await processAlerts({ conditions: cond({ stale: { active: true, payload: {} } }), states, settings, nowS: NOON, tz: TZ, record: h.record, notify: h.notify }));
  assert.deepEqual(h.sends, ["stale:fire"]);
  assert.deepEqual(h.records, ["stale:fire"]); // not re-recorded
  assert.equal(states.stale.fired, true);
});

test("the alert is recorded even when delivery fails, and delivery is retried", async () => {
  const bad = harness({ failSends: true });
  let { states } = await processAlerts({ conditions: cond({ failing: { active: true, payload: { runs: 2 } } }), states: {}, settings, nowS: NOON, tz: TZ, record: bad.record, notify: bad.notify });
  assert.deepEqual(bad.records, ["failing:fire"]);
  assert.equal(states.failing.pending, true);
  const good = harness();
  ({ states } = await processAlerts({ conditions: cond({ failing: { active: true, payload: { runs: 3 } } }), states, settings, nowS: NOON, tz: TZ, record: good.record, notify: good.notify }));
  assert.deepEqual(good.sends, ["failing:fire"]);
  assert.deepEqual(good.records, []);
});

test("an undelivered fire gets no recovery message", async () => {
  const h = harness();
  let { states } = await processAlerts({ conditions: cond({ stale: { active: true, payload: {} } }), states: {}, settings, nowS: NIGHT, tz: TZ, record: h.record, notify: h.notify });
  ({ states } = await processAlerts({ conditions: cond({}), states, settings, nowS: NOON, tz: TZ, record: h.record, notify: h.notify }));
  assert.deepEqual(h.records, ["stale:fire", "stale:recover"]);
  assert.deepEqual(h.sends, []);
});

test("conditions: stale after N days, invalid_grant means access lost, disabled alerts stay quiet", () => {
  const day = 86400;
  let c = evaluateConditions({ nowS: NOON, lastDataS: NOON - 3 * day, consecutiveFailures: 0, authFailed: false, settings });
  assert.equal(c.stale.active, true);
  assert.equal(c.stale.payload.days, 3);
  c = evaluateConditions({ nowS: NOON, lastDataS: NOON - day, consecutiveFailures: 0, authFailed: false, settings });
  assert.equal(c.stale.active, false);
  c = evaluateConditions({ nowS: NOON, lastDataS: NOON, consecutiveFailures: 5, authFailed: true, settings });
  assert.equal(c.auth.active, true);
  assert.equal(c.failing.active, false, "an auth failure is reported as access lost, not as a generic failing pull");
  c = evaluateConditions({ nowS: NOON, lastDataS: NOON, consecutiveFailures: 2, authFailed: false, settings });
  assert.equal(c.failing.active, true);
  const off = normaliseSettings({ alert_stale: false, alert_failing: false });
  c = evaluateConditions({ nowS: NOON, lastDataS: null, consecutiveFailures: 9, authFailed: true, settings: off });
  assert.equal(c.stale.active, false);
  assert.equal(c.failing.active, false);
  assert.equal(c.auth.active, true, "access lost is always on");
});

test("access-lost alert fires through the state machine", async () => {
  const h = harness();
  const c = evaluateConditions({ nowS: NOON, lastDataS: NOON, consecutiveFailures: 1, authFailed: true, settings });
  await processAlerts({ conditions: c, states: {}, settings, nowS: NOON, tz: TZ, record: h.record, notify: h.notify });
  assert.deepEqual(h.sends, ["auth:fire"]);
});

test("quiet hours wrap midnight and settings are clamped", () => {
  assert.equal(inQuietHours(settings, NIGHT, TZ), true);
  assert.equal(inQuietHours(settings, at("2026-09-12T11:30:00Z"), TZ), true); // 07:30 EDT
  assert.equal(inQuietHours(settings, at("2026-09-12T12:00:00Z"), TZ), false); // 08:00 EDT
  assert.equal(inQuietHours({ ...settings, quiet_enabled: false }, NIGHT, TZ), false);
  const s = normaliseSettings({ stale_days: "99", failing_runs: 0, quiet_start: "nonsense" });
  assert.equal(s.stale_days, 14);
  assert.equal(s.failing_runs, 1);
  assert.equal(s.quiet_start, DEFAULT_SETTINGS.quiet_start);
});
