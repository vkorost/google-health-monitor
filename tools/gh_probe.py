"""Google Health API probe: does Samsung Health data reach Google's cloud?

Throwaway experiment for build-order step 1. Standard library only.

    python tools/gh_probe.py auth               one-time consent, stores refresh token
    python tools/gh_probe.py auth --url "..."   same, non-interactive (paste the redirected URL)
    python tools/gh_probe.py probe              last 7 days of every type, raw JSON saved
    python tools/gh_probe.py probe --days 400 --types heart-rate,sleep

Inputs:  .secrets/client_secret.json   (Web application OAuth client, downloaded from GCP)
Outputs: .secrets/token.json           (refresh token; ACL restricted to the current user)
         probe-output/<type>.json      (raw API pages, the fixtures we reason from)

The OAuth shape deliberately matches what a Cloudflare Worker would use later
(Web client, refresh token, redirect https://www.google.com), which is why this
does not use the official ghealth CLI (Desktop client, needs Go).
"""

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SECRETS = ROOT / ".secrets"
CLIENT_FILE = SECRETS / "client_secret.json"
TOKEN_FILE = SECRETS / "token.json"
OUT_DIR = ROOT / "probe-output"

REDIRECT_URI = "https://www.google.com"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
API = "https://health.googleapis.com/v4/users/me/dataTypes"

SCOPES = [
    "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
    "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
    "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
]

# dataType -> record kind. The kind decides the filter field.
# Path identifiers use hyphens; filter prefixes use underscores (per the data-types doc).
TYPES = {
    "heart-rate": "sample",
    "heart-rate-variability": "sample",
    "oxygen-saturation": "sample",
    "respiratory-rate-sleep-summary": "sample",
    "weight": "sample",
    "body-fat": "sample",
    "vo2-max": "sample",
    "steps": "interval",
    "distance": "interval",
    "active-energy-burned": "interval",
    "sleep": "session",
    "exercise": "session",
    "daily-resting-heart-rate": "daily",
    "daily-heart-rate-variability": "daily",
    "daily-oxygen-saturation": "daily",
    "daily-respiratory-rate": "daily",
    "daily-sleep-temperature-derivations": "daily",
    "daily-vo2-max": "daily",
}

MAX_PAGES = 10
UA = "health-data-app-probe/0.1"

# Leaf keys that could say where a record came from. We do not know the schema
# for non-Google sources yet, so match broadly and let the output tell us.
SOURCE_KEY = re.compile(r"source|platform|application|app|device|origin|package|manufacturer|model", re.I)
TIME_KEY = re.compile(r"(time|date)$", re.I)


def http(method, url, headers=None, data=None):
    headers = {"User-Agent": UA, **(headers or {})}
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    if body is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, {"raw": raw}


def load_client():
    if not CLIENT_FILE.exists():
        sys.exit(f"Missing {CLIENT_FILE}. Download the OAuth client JSON from GCP and save it there.")
    doc = json.loads(CLIENT_FILE.read_text())
    c = doc.get("web") or doc.get("installed")
    if not c:
        sys.exit("client_secret.json has neither 'web' nor 'installed' section.")
    if "web" not in doc:
        print("Warning: this is not a Web application client; redirect to google.com may be rejected.")
    return c["client_id"], c["client_secret"]


def restrict_acl(path):
    # Refresh token plus client secret is standing read access to the health record.
    user = os.environ.get("USERNAME")
    if os.name == "nt" and user:
        subprocess.run(["icacls", str(path), "/inheritance:r", "/grant:r", f"{user}:F"],
                       check=False, capture_output=True)


def cmd_auth(args):
    client_id, client_secret = load_client()
    params = {
        "client_id": client_id,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",
        "prompt": "consent",
    }
    if args.url:
        pasted = args.url.strip()
    else:
        print("\n1. Open this URL in a browser signed in ONLY as the target Google account:\n")
        print(AUTH_URL + "?" + urllib.parse.urlencode(params))
        print("\n2. Approve. On 'Google hasn't verified this app' choose Advanced, then continue.")
        print("3. You land on a google.com page. Copy the ENTIRE address bar URL.\n")
        try:
            pasted = input("Paste the redirected URL: ").strip()
        except EOFError:
            # Non-interactive shell (isatty can lie under some hosts); fall back to --url.
            print('\nThen run: python tools/gh_probe.py auth --url "<pasted URL>"')
            return
    qs = urllib.parse.parse_qs(urllib.parse.urlparse(pasted).query)
    if "error" in qs:
        sys.exit(f"Consent returned error: {qs['error'][0]}")
    if "code" not in qs:
        sys.exit("No 'code' parameter in that URL.")
    granted = set(qs.get("scope", [""])[0].split())
    missing = [s for s in SCOPES if s not in granted]
    if missing:
        print("Warning: these scopes were NOT granted (unticked on the consent screen?):")
        for s in missing:
            print("  ", s)

    status, tok = http("POST", TOKEN_URL, data={
        "code": qs["code"][0],
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": REDIRECT_URI,
        "grant_type": "authorization_code",
    })
    if status != 200 or "refresh_token" not in tok:
        sys.exit(f"Token exchange failed ({status}): {json.dumps(tok, indent=2)}")

    SECRETS.mkdir(exist_ok=True)
    TOKEN_FILE.write_text(json.dumps({
        "refresh_token": tok["refresh_token"],
        "scope": tok.get("scope"),
        "issued_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }, indent=2))
    restrict_acl(TOKEN_FILE)
    print(f"\nRefresh token saved to {TOKEN_FILE}. Now run: python tools/gh_probe.py probe")


def access_token():
    client_id, client_secret = load_client()
    if not TOKEN_FILE.exists():
        sys.exit("No token yet. Run: python tools/gh_probe.py auth")
    saved = json.loads(TOKEN_FILE.read_text())
    issued = dt.datetime.fromisoformat(saved["issued_at"])
    age_days = (dt.datetime.now(dt.timezone.utc) - issued).total_seconds() / 86400
    status, tok = http("POST", TOKEN_URL, data={
        "refresh_token": saved["refresh_token"],
        "client_id": client_id,
        "client_secret": client_secret,
        "grant_type": "refresh_token",
    })
    if status != 200:
        # invalid_grant around day 7 means the consent app is still in Testing.
        sys.exit(f"Refresh failed ({status}) with token age {age_days:.1f} days: {tok}. "
                 "Re-run auth. If this happens at ~7 days, the app is in Testing status.")
    print(f"Access token OK (refresh token age {age_days:.1f} days)")
    return tok["access_token"]


def build_filter(dtype, kind, days):
    prefix = dtype.replace("-", "_")
    now = dt.datetime.now(dt.timezone.utc)
    start = now - dt.timedelta(days=days)
    iso = start.strftime("%Y-%m-%dT%H:%M:%SZ")
    if kind == "sample":
        return f'{prefix}.sample_time.physical_time >= "{iso}"'
    if kind == "session":
        # Sessions reject interval.start_time (INVALID_DATA_POINT_FILTER_DATA_TYPE_MEMBER); end_time works.
        return f'{prefix}.interval.end_time >= "{iso}"'
    if kind == "interval":
        return f'{prefix}.interval.start_time >= "{iso}"'
    return f'{prefix}.date >= "{start.date().isoformat()}"'


def walk(node, path=""):
    if isinstance(node, dict):
        for k, v in node.items():
            yield from walk(v, f"{path}.{k}" if path else k)
    elif isinstance(node, list):
        for v in node:
            yield from walk(v, path + "[]")
    else:
        yield path, node


def fetch_type(token, dtype, kind, days):
    page_size = 25 if kind == "session" else 10000
    flt = build_filter(dtype, kind, days)
    pages, points, note = [], [], ""
    page_token = None
    for _ in range(MAX_PAGES):
        q = {"pageSize": page_size}
        if flt:
            q["filter"] = flt
        if page_token:
            q["pageToken"] = page_token
        url = f"{API}/{dtype}/dataPoints?" + urllib.parse.urlencode(q)
        status, body = http("GET", url, headers={"Authorization": f"Bearer {token}"})
        if status == 400 and flt and not pages:
            # Our guessed filter syntax may be wrong for this type; retry unfiltered once.
            note = f"filter rejected: {body.get('error', {}).get('message', body)}; retried unfiltered"
            flt = None
            continue
        pages.append({"status": status, "url": url, "body": body})
        if status != 200:
            break
        points.extend(body.get("dataPoints", []))
        page_token = body.get("nextPageToken")
        if not page_token:
            break
    else:
        note = (note + "; " if note else "") + f"stopped at {MAX_PAGES} pages"
    return pages, points, note


def summarise(points):
    sources, times = Counter(), []
    for p in points:
        seen = set()
        for path, val in walk(p):
            leaf = path.rsplit(".", 1)[-1].rstrip("[]")
            if SOURCE_KEY.search(path) and isinstance(val, (str, int, bool)):
                seen.add(f"{path}={val}")
            if TIME_KEY.search(leaf) and isinstance(val, str) and val[:1].isdigit():
                times.append(val)
        sources.update(seen)
    return sources, (min(times), max(times)) if times else None


def cmd_probe(args):
    token = access_token()
    OUT_DIR.mkdir(exist_ok=True)
    wanted = args.types.split(",") if args.types else list(TYPES)
    for dtype in wanted:
        kind = TYPES.get(dtype, "sample")
        pages, points, note = fetch_type(token, dtype, kind, args.days)
        (OUT_DIR / f"{dtype}.json").write_text(json.dumps(pages, indent=2))
        last = pages[-1] if pages else {"status": "none", "body": {}}
        print(f"\n== {dtype} ({kind}) HTTP {last['status']}  points={len(points)}")
        if note:
            print("   note:", note)
        if last["status"] != 200:
            err = last["body"].get("error", last["body"])
            print("   error:", json.dumps(err)[:400])
            continue
        sources, span = summarise(points)
        if span:
            print(f"   time span: {span[0]}  ..  {span[1]}")
        for s, n in sources.most_common(12):
            print(f"   {n:>6}  {s}")
    print(f"\nRaw pages written to {OUT_DIR}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("auth")
    a.add_argument("--url", help="redirected google.com URL carrying ?code=; skips the prompt")
    p = sub.add_parser("probe")
    p.add_argument("--days", type=int, default=7)
    p.add_argument("--types", help="comma-separated dataType ids; default all")
    args = ap.parse_args()
    {"auth": cmd_auth, "probe": cmd_probe}[args.cmd](args)


if __name__ == "__main__":
    main()
