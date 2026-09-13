import { test } from "node:test";
import assert from "node:assert/strict";
import { sqlValue, upsertSql } from "../src/db.js";

test("values are escaped; non-finite numbers become NULL", () => {
  assert.equal(sqlValue("O'Brien"), "'O''Brien'");
  assert.equal(sqlValue(null), "NULL");
  assert.equal(sqlValue(NaN), "NULL");
  assert.equal(sqlValue(61.5), "61.5");
  assert.equal(sqlValue('[[0,20,"l"]]'), `'[[0,20,"l"]]'`);
});

test("upserts chunk under the byte cap and keep every row", () => {
  const rows = Array.from({ length: 5000 }, (_, i) => ({ start_ts: 1_700_000_000 + i * 900, min: 50, avg: 60.5, max: 70 }));
  const stmts = upsertSql("hr_buckets", rows, 20_000);
  assert.ok(stmts.length > 1);
  for (const s of stmts) {
    assert.ok(s.length <= 20_000, `statement of ${s.length} bytes`);
    assert.match(s, /ON CONFLICT\(start_ts\) DO UPDATE SET min = excluded\.min, avg = excluded\.avg, max = excluded\.max;$/);
  }
  const tuples = stmts.reduce((n, s) => n + (s.match(/\(\d{10}, /g) || []).length, 0);
  assert.equal(tuples, 5000);
});

test("workout upsert never wipes a derived max_hr with NULL", () => {
  const [s] = upsertSql("workouts", [{ id: "1", type: "SWIMMING", start_ts: 1, end_ts: 2, max_hr: null }]);
  assert.match(s, /max_hr = COALESCE\(excluded\.max_hr, workouts\.max_hr\)/);
  assert.equal(upsertSql("body", []).length, 0);
});
