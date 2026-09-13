import test from "node:test";
import assert from "node:assert/strict";
import { sleepScore } from "../src/metrics.js";

// Build a night from cycles: [light, deep, light, rem] minutes, with optional wake blips.
function night(cycles, wake = []) {
  const out = []; let t = 0;
  const push = (len, c) => { out.push([t, len, c]); t += len; };
  cycles.forEach((cy, i) => { push(cy[0], "l"); push(cy[1], "d"); push(cy[2], "l"); push(cy[3], "r"); if (wake[i]) push(wake[i], "a"); });
  return { stages: out, inBed: t };
}

test("a long, well-structured night is Excellent", () => {
  const n = night([[25, 40, 15, 20], [20, 30, 20, 25], [30, 15, 20, 30], [35, 5, 25, 35], [30, 0, 20, 35]], [0, 4, 0, 5, 0]);
  const r = sleepScore(n.stages, n.inBed + 10);
  assert.equal(r.label, "Excellent");
  assert.equal(r.facts.cycles, 5);
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
