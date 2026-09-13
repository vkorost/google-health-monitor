"""Readers for the Samsung Health "Download personal data" export. Standard library only.

Shared by tools/samsung_import.py and tools/fit_sleep_score.py. Deterministic, no model calls.

Export layout (verified against a 2026 export):
  <prefix>.<timestamp>.csv   row 1 is metadata ("com.samsung.shealth.sleep,7006011,11"), row 2 the header.
                             Some columns carry a "com.samsung.health.<type>." prefix; it is stripped here.
  jsons/<prefix>/<first char of file name>/<file name>   per-row binning data named in a CSV column.
Times are UTC wall clock ("2024-11-23 04:35:00.000"); each row has time_offset like "UTC-0500".
"""

import csv
import datetime as dt
import glob
import json
import re
import sys
from pathlib import Path

csv.field_size_limit(min(sys.maxsize, 2**31 - 1))

# Samsung Health Data SDK codes, checked against the Health Connect copy of the same nights and sessions.
STAGE_CODES = {40001: "a", 40002: "l", 40003: "d", 40004: "r"}  # awake, light, deep, REM (compact codes as in stages_json)
EXERCISE_TYPES = {1001: "WALKING", 1002: "RUNNING", 11007: "BIKING", 14001: "SWIMMING"}

_OFFSET = re.compile(r"^UTC([+-])(\d{2})(\d{2})$")


def read_csv(export_dir, prefix):
    """All rows of <prefix>.<14-digit timestamp>.csv as dicts, column prefixes stripped. [] when absent."""
    files = sorted(f for f in glob.glob(str(Path(export_dir) / f"{prefix}.*.csv"))
                   if re.fullmatch(re.escape(prefix) + r"\.\d{14}\.csv", Path(f).name))
    if not files:
        return []
    with open(files[-1], encoding="utf-8-sig", newline="") as fh:
        fh.readline()  # metadata row
        reader = csv.reader(fh)
        header = next(reader)
        cols = [c.split(".")[-1] if c.startswith("com.samsung.") else c for c in header]
        return [dict(zip(cols, row)) for row in reader]


def json_file(export_dir, prefix, name):
    if not name:
        return None
    p = Path(export_dir) / "jsons" / prefix / name[0] / name
    return p if p.exists() else None


def parse_utc(s):
    s = (s or "").strip()
    if not s:
        return None
    for fmt, n in (("%Y-%m-%d %H:%M:%S.%f", 23), ("%Y-%m-%d %H:%M:%S", 19)):
        try:
            return dt.datetime.strptime(s[:n], fmt).replace(tzinfo=dt.timezone.utc)
        except ValueError:
            continue
    return None


def offset_seconds(s):
    m = _OFFSET.match((s or "").strip())
    if not m:
        return None
    return (-1 if m.group(1) == "-" else 1) * (int(m.group(2)) * 3600 + int(m.group(3)) * 60)


def epoch(t):
    return int(t.timestamp()) if t else None


def local_date(epoch_s, offset_s):
    return dt.datetime.fromtimestamp(epoch_s + (offset_s or 0), dt.timezone.utc).date().isoformat()


def num(v):
    try:
        f = float(v)
        return None if f != f else f
    except (TypeError, ValueError):
        return None


def compact_stages(segments, start_s):
    """[(start_s, end_s, code)] -> [[offsetMin, lenMin, code]] sorted, adjacent same codes merged (as src/ingest.js)."""
    segs = sorted((s, e, c) for s, e, c in segments if c and e > s)
    out = []
    for s, e, c in segs:
        if out and out[-1][2] == c and abs(out[-1][1] - s) <= 1:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e, c])
    return [[round((s - start_s) / 60, 1), round((e - s) / 60, 1), c] for s, e, c in out]


def sleep_sessions(export_dir):
    """Sessions with stages. Returns list of dicts: id, start_s, end_s, offset_s, wake_date, score, efficiency, combined_id, segments."""
    stages = {}
    for r in read_csv(export_dir, "com.samsung.health.sleep_stage"):
        s, e = parse_utc(r.get("start_time")), parse_utc(r.get("end_time"))
        code = STAGE_CODES.get(int(num(r.get("stage")) or 0))
        if s and e and code:
            stages.setdefault(r.get("sleep_id"), []).append((epoch(s), epoch(e), code))
    out = []
    for r in read_csv(export_dir, "com.samsung.shealth.sleep"):
        s, e = parse_utc(r.get("start_time")), parse_utc(r.get("end_time"))
        if not s or not e or e <= s:
            continue
        off = offset_seconds(r.get("time_offset"))
        out.append({
            "id": r.get("datauuid"), "start_s": epoch(s), "end_s": epoch(e), "offset_s": off,
            "wake_date": local_date(epoch(e), off), "score": num(r.get("sleep_score")), "efficiency": num(r.get("efficiency")),
            "combined_id": (r.get("combined_id") or "").strip() or None, "segments": stages.get(r.get("datauuid"), []),
        })
    return out


def combined_scores(export_dir):
    return {r.get("datauuid"): num(r.get("sleep_score")) for r in read_csv(export_dir, "com.samsung.shealth.sleep_combined")}


def nights(export_dir):
    """Sessions joined by Samsung's combined_id (gaps become awake time). One dict per night:
    id, ids, start_s, end_s, offset_s, wake_date, score (combined score when joined), stages (compact), parts."""
    sessions = sleep_sessions(export_dir)
    comb = combined_scores(export_dir)
    groups = {}
    for s in sessions:
        groups.setdefault(s["combined_id"] or s["id"], []).append(s)
    out = []
    for key, g in groups.items():
        g.sort(key=lambda x: x["start_s"])
        segs = []
        for a, b in zip(g, g[1:]):
            if b["start_s"] > a["end_s"]:
                segs.append((a["end_s"], b["start_s"], "a"))
        for x in g:
            segs.extend(x["segments"])
        start, end = g[0]["start_s"], max(x["end_s"] for x in g)
        score = comb.get(key) if len(g) > 1 and comb.get(key) is not None else (g[0]["score"] if len(g) == 1 else None)
        out.append({
            "id": g[0]["id"], "ids": [x["id"] for x in g], "start_s": start, "end_s": end, "offset_s": g[-1]["offset_s"],
            "wake_date": g[-1]["wake_date"], "score": score, "efficiency": g[0]["efficiency"] if len(g) == 1 else None,
            "stages": compact_stages(segs, start), "parts": len(g), "has_stages": any(x["segments"] for x in g),
        })
    return out


def main_nights(night_list):
    best = {}
    for n in night_list:
        cur = best.get(n["wake_date"])
        if not cur or n["end_s"] - n["start_s"] > cur["end_s"] - cur["start_s"]:
            best[n["wake_date"]] = n
    return best
