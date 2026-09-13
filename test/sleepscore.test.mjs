import test from "node:test";
import assert from "node:assert/strict";
import { SLEEP_MODEL, nightScore, sleepLabel, sleepScore } from "../src/metrics.js";

// Build a night from cycles: [light, deep, light, rem] minutes, with optional wake blips.
function night(cycles, wake = []) {
  const out = []; let t = 0;
  const push = (len, c) => { out.push([t, len, c]); t += len; };
  cycles.forEach((cy, i) => { push(cy[0], "l"); push(cy[1], "d"); push(cy[2], "l"); push(cy[3], "r"); if (wake[i]) push(wake[i], "a"); });
  return { stages: out, inBed: t };
}

const good = night([[25, 40, 15, 20], [20, 30, 20, 25], [30, 15, 20, 30], [35, 5, 25, 35], [30, 0, 20, 35]], [0, 4, 0, 5, 0]);

test("a long, well-structured night scores well above a fragmented one of the same length", () => {
  const r = sleepScore(good.stages, good.inBed + 10);
  assert.ok(["Good", "Excellent"].includes(r.label), r.label);
  assert.equal(r.facts.cycles, 5);
  const frag = night([[25, 10, 15, 10], [20, 10, 20, 10], [30, 5, 20, 10], [35, 5, 25, 10], [30, 0, 20, 10]], [30, 25, 40, 30, 0]);
  const f = sleepScore(frag.stages, frag.inBed + 60);
  assert.ok(f.score < r.score - 10, `${f.score} vs ${r.score}`);
});

test("four hours of sleep cannot score above Attention even when structured well", () => {
  const n = night([[20, 40, 15, 20], [20, 30, 20, 25], [25, 10, 15, 20]]);
  const r = sleepScore(n.stages, n.inBed);
  assert.ok(r.facts.asleep_min <= 260);
  assert.equal(r.label, "Attention");
});

test("nights without stage detail get no score", () => {
  assert.equal(sleepScore([], 480), null);
  assert.equal(sleepScore([[0, 420, "s"]], 0), null);
});

test("fitted curves keep their shape: more efficiency, deep, REM or cycles never lowers the score; more awake time never raises it", () => {
  const nondecreasing = (pts) => pts.every((p, i) => i === 0 || p[1] >= pts[i - 1][1]);
  const nonincreasing = (pts) => pts.every((p, i) => i === 0 || p[1] <= pts[i - 1][1]);
  for (const k of ["efficiency", "deep_frac", "rem_frac", "cycles"]) assert.ok(nondecreasing(SLEEP_MODEL.curves[k]), k);
  for (const k of ["waso_min", "wakeups"]) assert.ok(nonincreasing(SLEEP_MODEL.curves[k]), k);
});

test("Samsung's own score wins when imported, and labels use the configured bands", () => {
  const s = nightScore(good.stages, good.inBed, 90);
  assert.equal(s.samsung, true);
  assert.equal(s.estimate, false);
  assert.equal(s.label, "Excellent");
  assert.equal(nightScore(good.stages, good.inBed, null).estimate, true);
  assert.equal(sleepLabel(89), "Good");
  assert.equal(sleepLabel(89, [85, 70, 50]), "Excellent");
  assert.equal(sleepLabel(49), "Attention");
});
