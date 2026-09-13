"""Samsung Health export -> SQL import files for the Health Monitor D1 database. Standard library only.

    python tools/samsung_import.py [--export data/samsung_export] [--out import/samsung] [--hr-days 365]

Then, from the repo root (in file order, a day apart if the row budget below says so):
    npx wrangler d1 execute healthmon --remote --file=import/samsung/01-....sql

What it writes (every statement is safe to re-run):
  nights            Samsung sessions joined by combined_id, only where no Health Connect night overlaps
                    by half of the shorter one (source 'samsung_export', id 'sx:<uuid>').
  workouts          Samsung workouts with the same rule (Samsung app records only; Polar comes through Google).
  hr_buckets        15-minute min/avg/max from the export's minute bins, last --hr-days days, only where
                    no bucket exists yet (Google's rollUp wins).
  rhr_daily         Lowest sleeping heart rate for export nights, only where none exists yet.
  steps_daily       Samsung's combined daily step total, only where none exists yet.
  samsung_nightly   Values only the export carries: Samsung's sleep score and efficiency, sleeping HR and HRV,
                    skin temperature relative to the previous 30 nights, respiratory rate, SpO2 and its low
                    duration, and the day's mean stress score. Replaced on every import.
  state             samsung_import: export timestamp, import time, row counts.

Deterministic, no model calls. Reads the export only; prints aggregate counts only.
"""

import argparse
import datetime as dt
import glob
import json
import re
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import samsung_export as sx  # noqa: E402

SRC = "samsung_export"
WATCH_PKG = "com.sec.android.app.shealth"
MAX_ROWS_PER_FILE = 80_000
MAX_BYTES_PER_STMT = 90_000
MAX_BYTES_PER_FILE = 4_500_000


def q(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return repr(round(v, 4)) if isinstance(v, float) else str(v)
    return "'" + str(v).replace("'", "''") + "'"


def statements(head, rows, tail):
    """Multi-row statements under the D1 statement size cap."""
    out, parts, size = [], [], len(head) + len(tail)
    for r in rows:
        t = "(" + ", ".join(q(x) for x in r) + ")"
        if parts and size + len(t) + 2 > MAX_BYTES_PER_STMT:
            out.append((head + ",\n".join(parts) + tail, len(parts)))
            parts, size = [], len(head) + len(tail)
        parts.append(t)
        size += len(t) + 2
    if parts:
        out.append((head + ",\n".join(parts) + tail, len(parts)))
    return out


def upsert_select_head(table, cols):
    # SELECT over a VALUES list so each row can carry a NOT EXISTS guard; columns are column1..columnN.
    return f"INSERT INTO {table} ({', '.join(cols)}) SELECT * FROM (VALUES "


def excluded_update(cols, key):
    return ", ".join(f"{c} = excluded.{c}" for c in cols if c not in key)


def stage_totals(stages):
    t = {"d": 0.0, "r": 0.0, "l": 0.0, "a": 0.0}
    for _, ln, c in stages:
        t[c] = t.get(c, 0.0) + ln
    return t


def bucket_rows(export_dir, since_s):
    """Minute bins -> {bucket_start: [min, sum_avg, n, max]} from tracker.heart_rate (JSON bins, else the CSV reading)."""
    prefix = "com.samsung.shealth.tracker.heart_rate"
    minutes = {}
    for r in sx.read_csv(export_dir, prefix):
        s = sx.parse_utc(r.get("start_time"))
        if not s or sx.epoch(s) < since_s - 3600:
            continue
        p = sx.json_file(export_dir, prefix, r.get("binning_data"))
        if p:
            for b in json.loads(p.read_text()):
                hr = b.get("heart_rate")
                if hr and hr > 0 and b.get("start_time") is not None:
                    t = int(b["start_time"] // 1000)
                    if t >= since_s:
                        minutes.setdefault(t - t % 60, (hr, b.get("heart_rate_min") or hr, b.get("heart_rate_max") or hr))
        else:
            hr = sx.num(r.get("heart_rate"))
            t = sx.epoch(s)
            if hr and hr > 0 and t >= since_s:
                minutes.setdefault(t - t % 60, (hr, sx.num(r.get("min")) or hr, sx.num(r.get("max")) or hr))
    buckets = {}
    for t, (avg, mn, mx) in minutes.items():
        k = t - t % 900
        b = buckets.setdefault(k, [mn, 0.0, 0, mx])
        b[0], b[1], b[2], b[3] = min(b[0], mn), b[1] + avg, b[2] + 1, max(b[3], mx)
    return buckets


def resting_hr(buckets, start_s, end_s):
    """Same rule as src/metrics.js restingHr: lowest mean of two consecutive 15-minute averages inside the night."""
    keys = sorted(k for k in buckets if k >= start_s and k + 900 <= end_s + 450)
    best = None
    for a, b in zip(keys, keys[1:]):
        if b - a != 900:
            continue
        v = (buckets[a][1] / buckets[a][2] + buckets[b][1] / buckets[b][2]) / 2
        best = v if best is None or v < best else best
    return None if best is None else round(best, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--export", default=str(ROOT / "data" / "samsung_export"))
    ap.add_argument("--out", default=str(ROOT / "import" / "samsung"))
    ap.add_argument("--hr-days", type=int, default=365)
    args = ap.parse_args()
    E, OUT = args.export, Path(args.out)
    stamp = next((m.group(1) for f in sorted(glob.glob(str(Path(E) / "com.samsung.shealth.sleep.*.csv")))
                  for m in [re.search(r"\.(\d{14})\.csv$", f)] if m), None)
    now_s = int(dt.datetime.now(dt.timezone.utc).timestamp())
    stmts = []  # (label, sql, rows)

    # ---- nights
    night_list = [n for n in sx.nights(E) if n["end_s"] > n["start_s"]]
    cols = ["id", "wake_date", "start_ts", "end_ts", "offset_s", "source", "deep_min", "rem_min", "light_min",
            "awake_min", "asleep_min", "stages_json", "updated_at"]
    rows = []
    for n in night_list:
        t = stage_totals(n["stages"])
        asleep = t["d"] + t["r"] + t["l"] if n["has_stages"] else (n["end_s"] - n["start_s"]) / 60
        rows.append(["sx:" + n["id"], n["wake_date"], n["start_s"], n["end_s"], n["offset_s"], SRC, round(t["d"], 1), round(t["r"], 1),
                     round(t["l"], 1), round(t["a"], 1), round(asleep, 1), json.dumps(n["stages"], separators=(",", ":")), None])
    guard = (") AS v WHERE NOT EXISTS (SELECT 1 FROM nights n WHERE n.source <> 'samsung_export'"
             " AND n.wake_date BETWEEN date(v.column2, '-1 day') AND date(v.column2, '+1 day')"
             " AND MIN(n.end_ts, v.column4) - MAX(n.start_ts, v.column3) >= 0.5 * MIN(n.end_ts - n.start_ts, v.column4 - v.column3))"
             f" ON CONFLICT(id) DO UPDATE SET {excluded_update(cols, ['id'])};")
    stmts += [("nights", s, k) for s, k in statements(upsert_select_head("nights", cols), rows, guard)]

    # ---- workouts (Samsung app records; Polar sessions already reach D1 through Google)
    cols = ["id", "type", "name", "start_ts", "end_ts", "offset_s", "active_s", "avg_hr", "max_hr", "source"]
    rows = []
    for r in sx.read_csv(E, "com.samsung.shealth.exercise"):
        if r.get("pkg_name") != WATCH_PKG:
            continue
        s, e = sx.parse_utc(r.get("start_time")), sx.parse_utc(r.get("end_time"))
        if not s or not e or e <= s:
            continue
        code = int(sx.num(r.get("exercise_type")) or 0)
        dur = sx.num(r.get("duration"))
        rows.append(["sx:" + r.get("datauuid"), sx.EXERCISE_TYPES.get(code, f"SAMSUNG_{code}"), None, sx.epoch(s), sx.epoch(e),
                     sx.offset_seconds(r.get("time_offset")), round(dur / 1000, 1) if dur else sx.epoch(e) - sx.epoch(s),
                     sx.num(r.get("mean_heart_rate")) or None, sx.num(r.get("max_heart_rate")) or None, SRC])
    guard = (") AS v WHERE NOT EXISTS (SELECT 1 FROM workouts w WHERE w.source <> 'samsung_export'"
             " AND w.start_ts BETWEEN v.column4 - 86400 AND v.column5"
             " AND MIN(w.end_ts, v.column5) - MAX(w.start_ts, v.column4) >= 0.5 * MIN(w.end_ts - w.start_ts, v.column5 - v.column4))"
             f" ON CONFLICT(id) DO UPDATE SET {excluded_update(cols, ['id'])};")
    stmts += [("workouts", s, k) for s, k in statements(upsert_select_head("workouts", cols), rows, guard)]
    n_workouts = len(rows)

    # ---- heart-rate buckets, last --hr-days days, never replacing Google's
    since = now_s - args.hr_days * 86400
    since -= since % 900
    buckets = bucket_rows(E, since)
    rows = [[k, v[0], round(v[1] / v[2], 1), v[3]] for k, v in sorted(buckets.items())]
    stmts += [("hr_buckets", s, k) for s, k in statements(
        "INSERT INTO hr_buckets (start_ts, min, avg, max) VALUES ", rows, " ON CONFLICT(start_ts) DO NOTHING;")]
    n_buckets = len(rows)

    # ---- lowest sleeping heart rate for export main nights, never replacing existing rows
    mains = sx.main_nights(night_list)
    rows = []
    for d, n in sorted(mains.items()):
        v = resting_hr(buckets, n["start_s"], n["end_s"])
        if v is not None:
            rows.append([d, v, "sx:" + n["id"]])
    stmts += [("rhr_daily", s, k) for s, k in statements(
        "INSERT INTO rhr_daily (date, bpm, night_id) VALUES ", rows, " ON CONFLICT(date) DO NOTHING;")]
    n_rhr = len(rows)

    # ---- steps: Samsung's "Combined" device is the total Health Connect receives
    combined = {r.get("deviceuuid") for r in sx.read_csv(E, "com.samsung.health.device_profile") if (r.get("model") or "") == "Combined"}
    steps = {}
    for r in sx.read_csv(E, "com.samsung.shealth.tracker.pedometer_day_summary"):
        if r.get("deviceuuid") in combined and sx.num(r.get("step_count")) is not None:
            steps[(r.get("day_time") or "")[:10]] = int(sx.num(r.get("step_count")))
    rows = [[d, v, WATCH_PKG] for d, v in sorted(steps.items()) if re.fullmatch(r"\d{4}-\d{2}-\d{2}", d)]
    stmts += [("steps_daily", s, k) for s, k in statements(
        "INSERT INTO steps_daily (date, steps, source) VALUES ", rows, " ON CONFLICT(date) DO NOTHING;")]
    n_steps = len(rows)

    # ---- samsung_nightly
    night = {d: {"sleep_score": n["score"], "efficiency": n["efficiency"]} for d, n in mains.items()}

    def nightly(prefix, field, target, transform=None):
        vals = {}
        for r in sx.read_csv(E, prefix):
            e = sx.parse_utc(r.get("end_time"))
            v = sx.num(r.get(field))
            if e and v is not None:
                vals[sx.local_date(sx.epoch(e), sx.offset_seconds(r.get("time_offset")))] = v
        for d, v in (transform(vals) if transform else vals).items():
            night.setdefault(d, {})[target] = v
        return vals

    def relative_to_prior_30(vals):
        # Samsung's baseline column is empty in exports seen so far, so compare with the user's own recent nights.
        out, dates = {}, sorted(vals)
        for i, d in enumerate(dates):
            prior = [vals[x] for x in dates[max(0, i - 30):i]]
            if len(prior) >= 7:
                out[d] = round(vals[d] - statistics.median(prior), 2)
        return out

    nightly("com.samsung.health.skin_temperature", "temperature", "skin_temp_delta", relative_to_prior_30)
    nightly("com.samsung.health.respiratory_rate", "average", "respiratory_rate")
    nightly("com.samsung.shealth.tracker.oxygen_saturation", "spo2", "spo2_avg")
    nightly("com.samsung.shealth.tracker.oxygen_saturation", "low_duration", "spo2_low_duration")
    for r in sx.read_csv(E, "com.samsung.shealth.vitality_score"):
        d = (r.get("day_time") or "")[:10]
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", d):
            if sx.num(r.get("shr_value")):
                night.setdefault(d, {})["sleeping_hr"] = sx.num(r.get("shr_value"))
            if sx.num(r.get("shrv_value")):
                night.setdefault(d, {})["sleeping_hrv"] = sx.num(r.get("shrv_value"))
    stress = {}
    for r in sx.read_csv(E, "com.samsung.shealth.stress"):
        s = sx.parse_utc(r.get("start_time"))
        v = sx.num(r.get("score"))
        if s and v is not None:
            stress.setdefault(sx.local_date(sx.epoch(s), sx.offset_seconds(r.get("time_offset"))), []).append(v)
    for d, vs in stress.items():
        night.setdefault(d, {})["stress_avg"] = round(sum(vs) / len(vs), 1)
    cols = ["wake_date", "sleep_score", "efficiency", "sleeping_hr", "sleeping_hrv", "skin_temp_delta",
            "respiratory_rate", "spo2_avg", "spo2_low_duration", "stress_avg", "source_note"]
    note = f"samsung export {stamp}" if stamp else "samsung export"
    rows = [[d] + [v.get(c) for c in cols[1:-1]] + [note] for d, v in sorted(night.items()) if any(v.get(c) is not None for c in cols[1:-1])]
    stmts += [("samsung_nightly", s, k) for s, k in statements(
        f"INSERT INTO samsung_nightly ({', '.join(cols)}) VALUES ", rows,
        f" ON CONFLICT(wake_date) DO UPDATE SET {excluded_update(cols, ['wake_date'])};")]
    n_nightly = len(rows)

    counts = {"nights_candidates": len(night_list), "workouts_candidates": n_workouts, "hr_bucket_candidates": n_buckets,
              "rhr_candidates": n_rhr, "steps_days": n_steps, "samsung_nightly": n_nightly}
    state = {"export": stamp, "imported_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "counts": counts}
    stmts.append(("state", "INSERT INTO state (key, value) VALUES ('samsung_import', " + q(json.dumps(state)) +
                  ") ON CONFLICT(key) DO UPDATE SET value = excluded.value;", 1))

    # ---- files: D1 counts index maintenance too, so budget two writes per row except hr_buckets/steps
    per_row = {"nights": 2, "workouts": 2, "hr_buckets": 1, "rhr_daily": 2, "steps_daily": 1, "samsung_nightly": 1, "state": 1}
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.sql"):
        old.unlink()
    files, buf, writes, size, part, label = [], [], 0, 0, 1, None

    def flush():
        nonlocal buf, writes, size, part
        if buf:
            name = f"{part:02d}-{label}.sql"
            (OUT / name).write_text("\n".join(buf) + "\n", encoding="utf-8")
            files.append((name, writes, size))
            part += 1
            buf, writes, size = [], 0, 0

    for lab, sql, k in stmts:
        w = k * per_row[lab]
        if buf and (lab != label or writes + w > MAX_ROWS_PER_FILE or size + len(sql) > MAX_BYTES_PER_FILE):
            flush()
        label = lab
        buf.append(sql)
        writes += w
        size += len(sql) + 1
    flush()

    print("Candidate rows (guards skip rows D1 already has):")
    for k, v in counts.items():
        print(f"  {k}: {v:,}")
    print("Files (import in order):")
    total = 0
    for name, w, sz in files:
        total += w
        print(f"  {Path(args.out).name}/{name}  {sz / 1024:,.0f} KB  up to ~{w:,} row writes")
    print(f"Upper bound on row writes: ~{total:,} (D1 free plan: 100,000 per day). Guarded rows that already exist are not written.")


if __name__ == "__main__":
    main()
