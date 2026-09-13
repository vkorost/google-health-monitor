"""Fit the dashboard's sleep score to Samsung's own sleep score. Deterministic, standard library only.

    python tools/fit_sleep_score.py [--export data/samsung_export] [--google data/raw/sleep.ndjson.gz] [--write]

1. Reads Samsung's export: nights (sessions joined by combined_id) with stages and Samsung's score.
2. Computes the facts for each night with the Worker's own metrics.sleepFacts (tools/sleep_facts.mjs),
   so the fit and the dashboard share one definition.
3. Splits main nights 80/20 by a hash of the wake date (fixed, so reruns give the same split).
4. Fits score = intercept + sum of per-factor piecewise-linear curves (values at fixed knots taken from
   training quantiles) by ridge least squares with shape bounds (see SIGN); the ridge strength is picked
   on a split inside the training set.
5. Reports r, MAE and 4-label agreement on the held-out nights, before (the previous hand-set formula)
   and after, and the same for nights computed from Google Health data when --google is given.
6. With --write, replaces SLEEP_MODEL in src/metrics.js (between the "fitted" markers).

Prints aggregate statistics only.
"""

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import samsung_export as sx  # noqa: E402

FACTORS = ["hours", "efficiency", "deep_frac", "rem_frac", "waso_min", "wakeups", "cycles"]
ROUND = {"hours": 0.25, "efficiency": 0.01, "deep_frac": 0.01, "rem_frac": 0.01, "waso_min": 5, "wakeups": 1, "cycles": 1}
BANDS = [90, 70, 50]
# Hand-set prior, not fitted: few recorded nights are short, so the data cannot teach how much a
# 4-hour night should lose. The score may not exceed this curve of hours asleep.
SHORT_SLEEP_CAP = [[4, 40], [6, 76], [7, 97]]


def cap_for(hours):
    pts = SHORT_SLEEP_CAP
    if hours <= pts[0][0]:
        return pts[0][1]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if hours <= x1:
            return y0 + (y1 - y0) * (hours - x0) / (x1 - x0)
    return 100


def label(score, bands=BANDS):
    return "Excellent" if score >= bands[0] else "Good" if score >= bands[1] else "Fair" if score >= bands[2] else "Attention"


def holdout(key):
    return int(hashlib.sha256(key.encode()).hexdigest(), 16) % 5 == 0


def inner_holdout(key):
    return int(hashlib.sha256(("inner:" + key).encode()).hexdigest(), 16) % 5 == 0


def node(mode, inp, out, tz="America/New_York"):
    res = subprocess.run(["node", str(ROOT / "tools" / "sleep_facts.mjs"), mode, str(inp), str(out), tz], capture_output=True, text=True)
    if res.returncode:
        raise SystemExit(res.stderr)
    return json.loads(Path(out).read_text())


def quantile(xs, p):
    xs = sorted(xs)
    i = (len(xs) - 1) * p
    lo, hi = math.floor(i), math.ceil(i)
    return xs[lo] + (xs[hi] - xs[lo]) * (i - lo)


def knots_for(values, factor):
    step = ROUND[factor]
    ks = sorted({round(round(quantile(values, p) / step) * step, 4) for p in (0.05, 0.35, 0.65, 0.95)})
    return ks if len(ks) >= 2 else [ks[0], ks[0] + step]


def hat(x, ks):
    b = [0.0] * len(ks)
    if x <= ks[0]:
        b[0] = 1.0
    elif x >= ks[-1]:
        b[-1] = 1.0
    else:
        for j in range(len(ks) - 1):
            if ks[j] <= x <= ks[j + 1]:
                t = (x - ks[j]) / (ks[j + 1] - ks[j])
                b[j], b[j + 1] = 1 - t, t
                break
    return b


# Shape priors keep every curve explainable: more efficiency, deep, REM or cycles never lowers
# the score, more awake time or wake-ups never raises it. Sleep duration is left free (too little
# and too much can both cost points).
SIGN = {"hours": 0, "efficiency": 1, "deep_frac": 1, "rem_frac": 1, "waso_min": -1, "wakeups": -1, "cycles": 1}


def columns(r, knots):
    """Increment basis: the curve value at knot j is the sum of increments 1..j, so each column is
    'how far past knot i-1 toward knot i the value is', and a sign bound on an increment is a
    monotonicity bound on the curve."""
    out = []
    for f in FACTORS:
        h = hat(r["facts"][f], knots[f])
        for i in range(1, len(h)):
            out.append(sum(h[i:]))
    return out


def bounds(knots):
    out = []
    for f in FACTORS:
        out += [SIGN[f]] * (len(knots[f]) - 1)
    return out


def fit(rows, knots, lam, iters=400):
    """Least squares with ridge on the increments, sign-bounded, by coordinate descent. Returns [intercept, *increments]."""
    X = [columns(r, knots) for r in rows]
    y = [r["score"] for r in rows]
    k = len(X[0])
    sg = bounds(knots)
    b0 = sum(y) / len(y)
    w = [0.0] * k
    resid = [t - b0 for t in y]
    norms = [sum(x[j] * x[j] for x in X) for j in range(k)]
    for _ in range(iters):
        shift = sum(resid) / len(resid)
        b0 += shift
        resid = [e - shift for e in resid]
        for j in range(k):
            if norms[j] == 0:
                continue
            rho = sum(x[j] * e for x, e in zip(X, resid)) + norms[j] * w[j]
            nw = rho / (norms[j] + lam)
            if sg[j] > 0:
                nw = max(0.0, nw)
            elif sg[j] < 0:
                nw = min(0.0, nw)
            d = nw - w[j]
            if d:
                resid = [e - d * x[j] for x, e in zip(X, resid)]
                w[j] = nw
    return [b0] + w


def predict(b, rows, knots):
    return [max(0.0, min(100.0, cap_for(r["facts"]["hours"]), b[0] + sum(bi * xi for bi, xi in zip(b[1:], columns(r, knots))))) for r in rows]


def stats(pred, truth, bands=BANDS):
    n = len(truth)
    if n < 3:
        return None
    mp, mt = sum(pred) / n, sum(truth) / n
    cov = sum((p - mp) * (t - mt) for p, t in zip(pred, truth))
    sp = math.sqrt(sum((p - mp) ** 2 for p in pred)) or 1e-9
    st = math.sqrt(sum((t - mt) ** 2 for t in truth)) or 1e-9
    agree = sum(label(round(p), bands) == label(t, bands) for p, t in zip(pred, truth)) / n
    return {"n": n, "r": round(cov / (sp * st), 3), "mae": round(sum(abs(p - t) for p, t in zip(pred, truth)) / n, 2),
            "bias": round(mp - mt, 2), "label_agreement": round(agree, 3)}


def to_model(b, knots):
    intercept, i, curves = b[0], 1, {}
    for f in FACTORS:
        vals, acc = [0.0], 0.0
        for _ in range(len(knots[f]) - 1):
            acc += b[i]
            vals.append(acc)
            i += 1
        m = min(vals)
        intercept += m
        curves[f] = [[kn, round(v - m, 2)] for kn, v in zip(knots[f], vals)]
    return {"intercept": round(intercept, 2), "curves": curves, "cap": SHORT_SLEEP_CAP}


def old_scores(rows):
    """Previous hand-set formula, for the 'before' numbers. Mirrors the formula shipped before the refit."""
    def curve(x, pts):
        if x <= pts[0][0]:
            return pts[0][1]
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            if x <= x1:
                return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
        return pts[-1][1]
    out = []
    for r in rows:
        f = r["facts"]
        parts = {
            "duration": curve(f["hours"], [[4, 0], [6, 60], [7, 95], [7.5, 100], [9, 100], [10.5, 75]]),
            "efficiency": curve(f["efficiency"], [[0.7, 0], [0.8, 50], [0.88, 85], [0.93, 100]]),
            "deep": curve(f["deep_frac"], [[0.05, 10], [0.1, 60], [0.15, 90], [0.18, 100]]),
            "rem": curve(f["rem_frac"], [[0.08, 10], [0.14, 60], [0.19, 90], [0.22, 100]]),
            "awakenings": min(curve(f["waso_min"], [[20, 100], [45, 85], [90, 50], [150, 0]]), curve(f["wakeups"], [[3, 100], [6, 70], [12, 20]])),
            "cycles": curve(f["cycles"], [[1, 20], [2, 55], [3, 80], [4, 100]]),
        }
        w = {"duration": 30, "efficiency": 15, "deep": 15, "rem": 15, "awakenings": 15, "cycles": 10}
        total = sum(parts[k] * w[k] / 100 for k in w)
        out.append(min(total, 40 + parts["duration"] * 0.6))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--export", default=str(ROOT / "data" / "samsung_export"))
    ap.add_argument("--google", default=str(ROOT / "data" / "raw" / "sleep.ndjson.gz"))
    ap.add_argument("--tz", default=os.environ.get("HEALTH_TZ", "America/New_York"))
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    mains = sx.main_nights(sx.nights(args.export))
    items = [{"key": d, "stages": n["stages"], "in_bed_min": (n["end_s"] - n["start_s"]) / 60, "score": n["score"],
              "start_s": n["start_s"], "end_s": n["end_s"]}
             for d, n in mains.items() if n["score"] is not None and n["has_stages"]]
    tmp = Path(tempfile.mkdtemp())
    (tmp / "in.json").write_text(json.dumps(items))
    facts = {r["key"]: r for r in node("export", tmp / "in.json", tmp / "out.json", args.tz)}
    rows = [dict(it, facts=facts[it["key"]]["facts"]) for it in items if facts.get(it["key"], {}).get("facts")]
    train = [r for r in rows if not holdout(r["key"])]
    test = [r for r in rows if holdout(r["key"])]
    print(f"Samsung-scored main nights with stages: {len(rows)} (train {len(train)}, held out {len(test)})")

    knots = {f: knots_for([r["facts"][f] for r in train], f) for f in FACTORS}
    fit_in = [r for r in train if not inner_holdout(r["key"])]
    val_in = [r for r in train if inner_holdout(r["key"])]
    best = None
    for lam in (0.1, 1, 3, 10, 30):
        b = fit(fit_in, knots, lam)
        s = stats(predict(b, val_in, knots), [r["score"] for r in val_in])
        if best is None or s["mae"] < best[1]["mae"]:
            best = (lam, s)
    lam = best[0]
    b = fit(train, knots, lam)
    model = to_model(b, knots)
    truth = [r["score"] for r in test]
    before = stats(old_scores(test), truth, [88, 75, 55])
    before_same_bands = stats(old_scores(test), truth)
    after = stats(predict(b, test, knots), truth)
    print(f"ridge lambda {lam}")
    print("held-out, export stages  before (old formula, old bands 88/75/55):", before)
    print("held-out, export stages  before (old formula, bands 90/70/50):   ", before_same_bands)
    print("held-out, export stages  after  (fitted, bands 90/70/50):        ", after)

    report = {"lambda": lam, "n_train": len(train), "n_test": len(test), "before_old_bands": before,
              "before_new_bands": before_same_bands, "after": after, "model": model}

    if args.google and Path(args.google).exists():
        g = node("google", args.google, tmp / "google.json", args.tz)
        by_date = {r["key"]: r for r in rows}
        pairs = []
        for r in g:
            s = by_date.get(r["key"])
            if not s or not r["facts"]:
                continue
            ov = min(r["end_s"], s["end_s"]) - max(r["start_s"], s["start_s"])
            if ov >= 0.5 * min(r["end_s"] - r["start_s"], s["end_s"] - s["start_s"]):
                pairs.append((r, s))
        gtest = [(r, s) for r, s in pairs if holdout(r["key"])]
        gt = [s["score"] for _, s in gtest]
        greport = {
            "n_pairs": len(pairs), "n_test": len(gtest),
            "before_old_bands": stats(old_scores([r for r, _ in gtest]), gt, [88, 75, 55]),
            "after": stats(predict(b, [r for r, _ in gtest], knots), gt),
        }
        print("held-out, Google Health nights (the dashboard's path):", greport)
        report["google"] = greport

    if args.write:
        p = ROOT / "src" / "metrics.js"
        src = p.read_text(encoding="utf-8")
        a = src.index("/* fitted: begin */")
        z = src.index("/* fitted: end */")
        body = json.dumps(model, separators=(", ", ": "))
        p.write_text(src[:a] + "/* fitted: begin */ " + body + " " + src[z:], encoding="utf-8")
        print("SLEEP_MODEL written to src/metrics.js")
    (tmp / "report.json").write_text(json.dumps(report, indent=2))
    print("report:", tmp / "report.json")


if __name__ == "__main__":
    main()
