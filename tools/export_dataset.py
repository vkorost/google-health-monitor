"""Export your full Google Health record to data/ for offline analysis.

    python tools/export_dataset.py            # resumable: finished pulls are reused from data/raw/

Deterministic, no model calls. Reads .secrets/ via tools/gh_probe.py, read-only API.

Output (data/):
  raw/<type>.ndjson.gz          every data point exactly as the API returned it
  raw/heart_rate_1min/*.json    rollUp pages, one per 6-day window
  csv/<table>.csv               one CSV per table
  health.sqlite                 the same tables
  README.md                     data dictionary and known problems
  manifest.json                 row counts, date ranges, export time
"""

import csv, datetime as dt, gzip, json, os, re, sqlite3, subprocess, sys, time, urllib.parse, urllib.request, urllib.error
from collections import defaultdict
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import gh_probe as g  # noqa: E402

TZ_NAME = os.environ.get("HEALTH_TZ", "America/New_York")  # local-time columns; match the Worker TZ var
TZ = ZoneInfo(TZ_NAME)
DATA = ROOT / "data"
RAW = DATA / "raw"
HR_DIR = RAW / "heart_rate_1min"
CSV_DIR = DATA / "csv"
TMP = DATA / "_tmp"
HR_START = dt.datetime(2018, 1, 1, tzinfo=dt.timezone.utc)

# Every type the three granted scopes can list. heart-rate is pulled separately via rollUp.
HIGH_VOLUME = {  # per-minute interval records: stored raw, tabulated as hourly sums per source
    "steps", "distance", "active-energy-burned", "active-minutes", "active-zone-minutes",
    "activity-level", "sedentary-period", "altitude", "time-in-heart-rate-zone", "swim-lengths-data",
}
LIST_TYPES = [
    "sleep", "exercise", "weight", "body-fat", "height",
    "oxygen-saturation", "heart-rate-variability", "respiratory-rate-sleep-summary", "vo2-max", "run-vo2-max",
    "core-body-temperature", "blood-glucose",
    "daily-resting-heart-rate", "daily-heart-rate-variability", "daily-oxygen-saturation", "daily-respiratory-rate",
    "daily-sleep-temperature-derivations", "daily-vo2-max", "daily-heart-rate-zones",
    *sorted(HIGH_VOLUME),
]

_token = {"value": None, "at": 0}


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def token():
    if time.time() - _token["at"] > 45 * 60:
        _token["value"], _token["at"] = g.access_token(), time.time()
    return _token["value"]


def call(method, url, body=None):
    """HTTP with retries on 429/5xx and one token refresh on 401."""
    for attempt in range(8):
        headers = {"Authorization": f"Bearer {token()}", "User-Agent": g.UA}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return 200, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            raw = e.read().decode(errors="replace")
            if e.code == 401 and attempt == 0:
                _token["at"] = 0
                continue
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(min(60, 2 ** attempt))
                continue
            try:
                return e.code, json.loads(raw)
            except json.JSONDecodeError:
                return e.code, {"raw": raw}
        except (urllib.error.URLError, TimeoutError):
            time.sleep(min(60, 2 ** attempt))
    return 599, {"error": "gave up after retries"}


# ------------------------------------------------------------------ pulling

def pull_list(dtype):
    """All pages of one type into raw/<type>.ndjson.gz. Skips types already pulled."""
    out = RAW / f"{dtype}.ndjson.gz"
    done = RAW / f"{dtype}.done"
    if done.exists():
        return json.loads(done.read_text())
    tmp = out.with_suffix(".partial")
    n, pages, page_token, status = 0, 0, None, 200
    with gzip.open(tmp, "wt", encoding="utf-8") as f:
        while True:
            q = {"pageSize": 25 if dtype in ("sleep", "exercise") else 10000}
            if page_token:
                q["pageToken"] = page_token
            status, body = call("GET", f"{g.API}/{dtype}/dataPoints?" + urllib.parse.urlencode(q))
            if status != 200:
                break
            for dp in body.get("dataPoints", []):
                f.write(json.dumps(dp, separators=(",", ":")) + "\n")
                n += 1
            pages += 1
            if pages % 50 == 0:
                log(f"  {dtype}: {n:,} points, {pages} pages")
            page_token = body.get("nextPageToken")
            if not page_token:
                break
    info = {"type": dtype, "points": n, "pages": pages, "status": status}
    if status != 200:
        info["error"] = str(body)[:300]
    tmp.replace(out)
    done.write_text(json.dumps(info))
    log(f"{dtype}: {n:,} points ({pages} pages){'' if status == 200 else ' HTTP ' + str(status)}")
    return info


def pull_heart_rate():
    """1-minute min/avg/max via rollUp in 6-day windows (windowSize * pageSize must stay within 14 days)."""
    HR_DIR.mkdir(parents=True, exist_ok=True)
    now = dt.datetime.now(dt.timezone.utc).replace(second=0, microsecond=0)
    start, windows, buckets = HR_START, 0, 0
    while start < now:
        end = min(start + dt.timedelta(days=6), now)
        path = HR_DIR / f"{start:%Y%m%d}.json"
        if not path.exists() or end == now:  # the newest window is always refreshed
            status, body = call("POST", f"{g.API}/heart-rate/dataPoints:rollUp", {
                "range": {"startTime": start.strftime("%Y-%m-%dT%H:%M:%SZ"), "endTime": end.strftime("%Y-%m-%dT%H:%M:%SZ")},
                "windowSize": "60s", "pageSize": 8640,
            })
            if status != 200:
                raise SystemExit(f"heart-rate rollUp failed for {start:%Y-%m-%d}: HTTP {status} {str(body)[:300]}")
            if body.get("nextPageToken"):
                raise SystemExit(f"unexpected second page for {start:%Y-%m-%d}; reduce the window")
            path.write_text(json.dumps(body.get("rollupDataPoints", []), separators=(",", ":")))
        windows += 1
        if windows % 50 == 0:
            log(f"  heart rate: {start:%Y-%m-%d} ({windows} windows)")
        start = end
    log(f"heart rate: {windows} windows")


# ------------------------------------------------------------------ shaping

def parse_iso(iso):
    """API timestamps carry 0 to 9 fractional digits; Python accepts at most 6."""
    m = re.match(r"^(.*?T\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d)?$", iso)
    frac = (m.group(2) or "")[:7]
    return dt.datetime.fromisoformat(m.group(1) + frac + ("+00:00" if (m.group(3) or "Z") == "Z" else m.group(3)))


def read_ndjson(dtype):
    p = RAW / f"{dtype}.ndjson.gz"
    if not p.exists():
        return
    with gzip.open(p, "rt", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                yield json.loads(line)


def camel(dtype):
    head, *rest = dtype.split("-")
    return head + "".join(w.capitalize() for w in rest)


def parse_offset(s):
    try:
        return dt.timedelta(seconds=float(str(s).rstrip("s")))
    except (TypeError, ValueError):
        return None


def local_str(iso, offset=None):
    if not iso:
        return None
    t = parse_iso(iso)
    loc = t + offset if offset is not None else t.astimezone(TZ)
    return loc.strftime("%Y-%m-%d %H:%M:%S")


def source_of(dp):
    ds = dp.get("dataSource", {}) or {}
    return (ds.get("application", {}) or {}).get("packageName") or (ds.get("device", {}) or {}).get("displayName") or ds.get("platform") or "unknown"


def source_meta(dp):
    ds = dp.get("dataSource", {}) or {}
    dev = ds.get("device", {}) or {}
    return {
        "source": source_of(dp), "platform": ds.get("platform"), "recording_method": ds.get("recordingMethod"),
        "device_name": dev.get("displayName"), "device_form_factor": dev.get("formFactor"), "device_manufacturer": dev.get("manufacturer"),
    }


def times_of(obj):
    """(start_utc, end_utc, local_start, local_date) for sample, interval or daily records."""
    if "sampleTime" in obj:
        st = obj["sampleTime"]
        iso = st.get("physicalTime")
        loc = local_str(iso, parse_offset(st.get("utcOffset")))
        return iso, None, loc, loc[:10] if loc else None
    if "interval" in obj:
        iv = obj["interval"]
        loc = local_str(iv.get("startTime"), parse_offset(iv.get("startUtcOffset")))
        return iv.get("startTime"), iv.get("endTime"), loc, loc[:10] if loc else None
    if "date" in obj and isinstance(obj["date"], dict):
        d = obj["date"]
        return None, None, None, f"{d['year']:04d}-{d['month']:02d}-{d['day']:02d}"
    return None, None, None, None


def leaves(node, path=""):
    if isinstance(node, dict):
        for k, v in node.items():
            if k in ("sampleTime", "interval", "date", "createTime", "updateTime") and not path:
                continue
            yield from leaves(v, f"{path}.{k}" if path else k)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from leaves(v, f"{path}[{i}]")
    else:
        yield path, node


def as_number(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.rstrip("s") if v.endswith("s") and v[:-1].replace(".", "", 1).lstrip("-").isdigit() else v
        try:
            return float(s)
        except ValueError:
            return None
    return None


# ------------------------------------------------------------------ database

SCHEMA = """
CREATE TABLE heart_rate_1min (start_utc TEXT PRIMARY KEY, start_local TEXT, local_date TEXT, bpm_min REAL, bpm_avg REAL, bpm_max REAL);
CREATE TABLE sleep_sessions (id TEXT PRIMARY KEY, source TEXT, wake_date TEXT, is_main_night INTEGER, start_utc TEXT, end_utc TEXT,
  start_local TEXT, end_local TEXT, in_bed_min REAL, asleep_min REAL, deep_min REAL, rem_min REAL, light_min REAL, awake_min REAL,
  has_stages INTEGER, sleep_score INTEGER, sleep_label TEXT, efficiency_pct INTEGER, deep_pct INTEGER, rem_pct INTEGER,
  awake_after_onset_min INTEGER, wakeups INTEGER, cycles INTEGER, resting_hr_bpm REAL);
CREATE TABLE sleep_stages (session_id TEXT, stage TEXT, start_utc TEXT, end_utc TEXT, start_local TEXT, minutes REAL);
CREATE TABLE workouts (id TEXT PRIMARY KEY, source TEXT, type TEXT, category TEXT, display_name TEXT, start_utc TEXT, end_utc TEXT,
  start_local TEXT, local_date TEXT, elapsed_min REAL, active_min REAL, avg_hr_reported REAL, avg_hr_1min REAL, max_hr_1min REAL,
  hidden_as_duplicate INTEGER, metrics_json TEXT);
CREATE TABLE workouts_combined (first_id TEXT, source TEXT, category TEXT, type TEXT, name TEXT, segments INTEGER, start_utc TEXT,
  end_utc TEXT, start_local TEXT, local_date TEXT, elapsed_min REAL, active_min REAL, avg_hr_reported REAL, avg_hr_1min REAL, max_hr_1min REAL);
CREATE TABLE body (id TEXT PRIMARY KEY, kind TEXT, time_utc TEXT, time_local TEXT, local_date TEXT, value REAL, unit TEXT,
  weight_lb REAL, source TEXT, is_repeat_write INTEGER);
CREATE TABLE daily_resting_hr_computed (date TEXT PRIMARY KEY, bpm REAL, night_id TEXT);
CREATE TABLE measurements (type TEXT, id TEXT, start_utc TEXT, end_utc TEXT, time_local TEXT, local_date TEXT, source TEXT,
  platform TEXT, device_name TEXT, field TEXT, value REAL, text_value TEXT);
CREATE TABLE activity_hourly (type TEXT, hour_local TEXT, local_date TEXT, source TEXT, field TEXT, value REAL, records INTEGER);
CREATE TABLE sources (source TEXT, type TEXT, platform TEXT, device_name TEXT, device_form_factor TEXT, first_utc TEXT, last_utc TEXT,
  first_date TEXT, last_date TEXT, records INTEGER);
CREATE INDEX hr_date ON heart_rate_1min(local_date);
CREATE INDEX st_session ON sleep_stages(session_id);
CREATE INDEX meas_type ON measurements(type, local_date);
CREATE INDEX act_type ON activity_hourly(type, local_date, source);
"""


def build_db():
    db_path = DATA / "health.sqlite"
    if db_path.exists():
        db_path.unlink()
    con = sqlite3.connect(db_path)
    con.executescript(SCHEMA)

    # ---- heart rate (inserted per window file; 4M rows never sit in memory at once)
    n_hr = 0
    for p in sorted(HR_DIR.glob("*.json")):
        rows = []
        for b in json.loads(p.read_text()):
            h = b.get("heartRate") or {}
            if h.get("beatsPerMinuteAvg") is None:
                continue
            t = parse_iso(b["startTime"]).astimezone(dt.timezone.utc)
            iso = t.strftime("%Y-%m-%dT%H:%M:%SZ")  # one fixed format so string ranges compare correctly
            loc = t.astimezone(TZ).strftime("%Y-%m-%d %H:%M:%S")
            rows.append((iso, loc, loc[:10], h.get("beatsPerMinuteMin"), round(h["beatsPerMinuteAvg"], 2), h.get("beatsPerMinuteMax")))
        con.executemany("INSERT OR REPLACE INTO heart_rate_1min VALUES (?,?,?,?,?,?)", rows)
        n_hr += len(rows)
    con.commit()
    log(f"heart_rate_1min: {n_hr:,} rows")

    def norm(iso):
        return parse_iso(iso).astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def hr_between(start_iso, end_iso):
        a, m = con.execute("SELECT AVG(bpm_avg), MAX(bpm_max) FROM heart_rate_1min WHERE start_utc >= ? AND start_utc < ?",
                           (norm(start_iso)[:17] + "00Z", norm(end_iso))).fetchone()
        return (round(a, 1) if a is not None else None, m)

    # ---- sleep and workouts via the Worker's own JS
    TMP.mkdir(parents=True, exist_ok=True)
    res = subprocess.run(["node", str(ROOT / "tools" / "export_node.mjs"), str(RAW), str(TMP), TZ_NAME], capture_output=True, text=True)
    if res.returncode != 0:
        raise SystemExit("export_node.mjs failed:\n" + res.stderr)
    log("node:", res.stdout.strip())
    sessions = json.loads((TMP / "sleep_sessions.json").read_text())

    # Resting HR, same rule as the dashboard: lowest mean of two consecutive 15-minute
    # bucket averages inside the main night. Buckets here are means of 1-minute averages.
    rhr_rows = []
    for s in sessions:
        s["resting_hr_bpm"] = None
        if not s["is_main_night"]:
            continue
        t0 = parse_iso(s["start_utc"])
        t1 = parse_iso(s["end_utc"])
        b0 = t0.replace(minute=t0.minute - t0.minute % 15, second=0, microsecond=0)
        mins = dict(con.execute("SELECT start_utc, bpm_avg FROM heart_rate_1min WHERE start_utc >= ? AND start_utc < ?",
                                (b0.strftime("%Y-%m-%dT%H:%M:%SZ"), t1.strftime("%Y-%m-%dT%H:%M:%SZ"))).fetchall())
        buckets = []
        t = b0
        while t + dt.timedelta(minutes=15) <= t1 + dt.timedelta(minutes=7, seconds=30):
            vals = [mins[k] for k in ((t + dt.timedelta(minutes=i)).strftime("%Y-%m-%dT%H:%M:%SZ") for i in range(15)) if k in mins]
            buckets.append(sum(vals) / len(vals) if len(vals) >= 8 else None)
            t += dt.timedelta(minutes=15)
        pairs = [(a + b) / 2 for a, b in zip(buckets, buckets[1:]) if a is not None and b is not None]
        if pairs:
            s["resting_hr_bpm"] = round(min(pairs), 1)
            rhr_rows.append((s["wake_date"], s["resting_hr_bpm"], s["id"]))
    cols = ["id", "source", "wake_date", "is_main_night", "start_utc", "end_utc", "start_local", "end_local", "in_bed_min", "asleep_min",
            "deep_min", "rem_min", "light_min", "awake_min", "has_stages", "sleep_score", "sleep_label", "efficiency_pct", "deep_pct",
            "rem_pct", "awake_after_onset_min", "wakeups", "cycles", "resting_hr_bpm"]
    con.executemany(f"INSERT OR REPLACE INTO sleep_sessions VALUES ({','.join('?' * len(cols))})", [[s[c] for c in cols] for s in sessions])
    con.executemany("INSERT OR REPLACE INTO daily_resting_hr_computed VALUES (?,?,?)", rhr_rows)
    stages = json.loads((TMP / "sleep_stages.json").read_text())
    con.executemany("INSERT INTO sleep_stages VALUES (?,?,?,?,?,?)",
                    [(x["session_id"], x["stage"], x["start_utc"], x["end_utc"], x["start_local"], x["minutes"]) for x in stages])
    log(f"sleep_sessions: {len(sessions):,}; sleep_stages: {len(stages):,}; resting HR days: {len(rhr_rows):,}")

    flags = {f["id"]: f for f in json.loads((TMP / "workout_flags.json").read_text())}
    wrows = []
    for dp in read_ndjson("exercise"):
        e = dp.get("exercise", {})
        iv = e.get("interval", {})
        if not iv.get("startTime") or not iv.get("endTime"):
            continue
        wid = str(dp.get("name", "")).split("/")[-1]
        loc = local_str(iv["startTime"], parse_offset(iv.get("startUtcOffset")))
        t0 = parse_iso(iv["startTime"])
        t1 = parse_iso(iv["endTime"])
        active = as_number(e.get("activeDuration"))
        avg1, max1 = hr_between(iv["startTime"], iv["endTime"])
        rep = as_number((e.get("metricsSummary") or {}).get("averageHeartRateBeatsPerMinute"))
        f = flags.get(wid, {})
        wrows.append((wid, source_of(dp), e.get("exerciseType"), f.get("category"), e.get("displayName"), iv["startTime"], iv["endTime"],
                      loc, loc[:10], round((t1 - t0).total_seconds() / 60, 1), round(active / 60, 1) if active else None,
                      rep if rep else None, avg1, max1, f.get("hidden_as_duplicate", 0),
                      json.dumps({k: v for k, v in e.items() if k not in ("interval",)}, separators=(",", ":"))))
    con.executemany(f"INSERT OR REPLACE INTO workouts VALUES ({','.join('?' * 16)})", wrows)
    comb = json.loads((TMP / "workouts_combined.json").read_text())
    crow = []
    for c in comb:
        avg1, max1 = hr_between(c["start_utc"], c["end_utc"])
        crow.append((c["first_id"], c["source"], c["category"], c["type"], c["name"], c["segments"], c["start_utc"], c["end_utc"],
                     c["start_local"], c["local_date"], c["elapsed_min"], c["active_min"], c["avg_hr_reported"], avg1, max1))
    con.executemany(f"INSERT INTO workouts_combined VALUES ({','.join('?' * 15)})", crow)
    log(f"workouts: {len(wrows):,}; workouts_combined: {len(crow):,}")

    # ---- body: flag repeat writes (same kind and value within 120 s), as the dashboard drops them
    brows = []
    for dtype, kind, key, field, unit in (("weight", "weight", "weight", "weightGrams", "g"), ("body-fat", "body_fat", "bodyFat", "percentage", "%")):
        pts = []
        for dp in read_ndjson(dtype):
            obj = dp.get(key, {})
            st = obj.get("sampleTime", {})
            val = as_number(obj.get(field))
            if st.get("physicalTime") and val is not None:
                pts.append((st["physicalTime"], dp, val, parse_offset(st.get("utcOffset"))))
        pts.sort(key=lambda x: x[0])
        prev = None
        for iso, dp, val, off in pts:
            t = parse_iso(iso)
            repeat = 1 if prev and (t - prev[0]).total_seconds() <= 120 and abs(val - prev[1]) < 1e-6 else 0
            if not repeat:
                prev = (t, val)
            loc = local_str(iso, off)
            brows.append((f"{kind}:{str(dp.get('name', '')).split('/')[-1]}", kind, iso, loc, loc[:10], val, unit,
                          round(val / 453.59237, 2) if kind == "weight" else None, source_of(dp), repeat))
    con.executemany("INSERT OR REPLACE INTO body VALUES (?,?,?,?,?,?,?,?,?,?)", brows)
    log(f"body: {len(brows):,}")

    # ---- everything else: long format, or hourly sums for per-minute activity types
    src_stats = defaultdict(lambda: {"first": None, "last": None, "fd": None, "ld": None, "n": 0, "meta": None})
    core = {"sleep", "exercise", "weight", "body-fat"}
    # Fitbit returns a zone table for every calendar day from year 1 onward; keep plausible dates only.
    first_ok, last_ok = "2010-01-01", (dt.date.today() + dt.timedelta(days=1)).isoformat()
    for dtype in LIST_TYPES:
        key = camel(dtype)
        hourly = defaultdict(lambda: [0.0, 0])
        mrows, n, skipped = [], 0, 0
        for dp in read_ndjson(dtype):
            obj = dp.get(key) or {}
            start, end, loc, ldate = times_of(obj)
            if ldate and not (first_ok <= ldate <= last_ok):
                skipped += 1
                continue
            meta = source_meta(dp)
            stt = src_stats[(meta["source"], dtype)]
            stt["n"] += 1
            stt["meta"] = stt["meta"] or meta
            if start:
                stt["first"] = min(filter(None, [stt["first"], start]))
                stt["last"] = max(filter(None, [stt["last"], start]))
            if ldate:
                stt["fd"] = min(filter(None, [stt["fd"], ldate]))
                stt["ld"] = max(filter(None, [stt["ld"], ldate]))
            if dtype in core:
                continue
            n += 1
            wid = str(dp.get("name", "")).split("/")[-1]
            if dtype in HIGH_VOLUME:
                if not loc:
                    continue
                # Categorical per-minute types (activity level, heart-rate zone) carry a label, not a number:
                # tabulate them as minutes per label. Types with no fields at all (sedentary-period) count minutes.
                minutes = (parse_iso(end) - parse_iso(start)).total_seconds() / 60 if start and end else 0
                labelled = False
                for field, v in leaves(obj):
                    num = as_number(v)
                    label = field if num is not None else f"{field}={v} (minutes)"  # not `key`: that names the record type
                    cell = hourly[(loc[:13] + ":00", meta["source"], label)]
                    cell[0] += num if num is not None else minutes
                    cell[1] += 1
                    labelled = True
                if not labelled:
                    cell = hourly[(loc[:13] + ":00", meta["source"], "minutes")]
                    cell[0] += minutes
                    cell[1] += 1
                continue
            for field, v in leaves(obj):
                num = as_number(v)
                mrows.append((dtype, wid, start, end, loc, ldate, meta["source"], meta["platform"], meta["device_name"], field,
                              num, None if num is not None else (None if v is None else str(v))))
            if len(mrows) > 200000:
                con.executemany("INSERT INTO measurements VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", mrows)
                mrows = []
        if mrows:
            con.executemany("INSERT INTO measurements VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", mrows)
        if hourly:
            con.executemany("INSERT INTO activity_hourly VALUES (?,?,?,?,?,?,?)",
                            [(dtype, h, h[:10], s, f, round(v[0], 3), v[1]) for (h, s, f), v in hourly.items()])
        if dtype not in core:
            log(f"{dtype}: {n:,} records{' -> ' + format(len(hourly), ',') + ' hourly cells' if hourly else ''}"
                f"{f', {skipped:,} skipped with implausible dates' if skipped else ''}")
    con.executemany("INSERT INTO sources VALUES (?,?,?,?,?,?,?,?,?,?)", [
        (s, t, v["meta"]["platform"], v["meta"]["device_name"], v["meta"]["device_form_factor"], v["first"], v["last"], v["fd"], v["ld"], v["n"])
        for (s, t), v in sorted(src_stats.items())])
    con.commit()
    return con


def export_csv(con):
    CSV_DIR.mkdir(parents=True, exist_ok=True)
    counts = {}
    for (table,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
        cur = con.execute(f"SELECT * FROM {table}")
        with open(CSV_DIR / f"{table}.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow([d[0] for d in cur.description])
            n = 0
            for row in cur:
                w.writerow(row)
                n += 1
        counts[table] = n
    return counts


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    log("Pulling list types")
    pulls = [pull_list(t) for t in LIST_TYPES]
    log("Pulling heart rate (1-minute rollUp)")
    pull_heart_rate()
    log("Building database")
    con = build_db()
    counts = export_csv(con)
    ranges = {
        "heart_rate_1min": con.execute("SELECT MIN(local_date), MAX(local_date) FROM heart_rate_1min").fetchone(),
        "sleep_sessions": con.execute("SELECT MIN(wake_date), MAX(wake_date) FROM sleep_sessions").fetchone(),
        "workouts": con.execute("SELECT MIN(local_date), MAX(local_date) FROM workouts").fetchone(),
        "body": con.execute("SELECT MIN(local_date), MAX(local_date) FROM body").fetchone(),
    }
    con.close()
    (DATA / "manifest.json").write_text(json.dumps({
        "exported_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "timezone_for_local_columns": TZ_NAME, "tables": counts,
        "date_ranges": {k: {"first": v[0], "last": v[1]} for k, v in ranges.items()},
        "api_pulls": pulls,
    }, indent=2))
    log("Done:", json.dumps(counts))


if __name__ == "__main__":
    main()
