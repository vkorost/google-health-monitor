# Assignment: build a personal Google Health dashboard

A complete brief for reproducing this project with an AI coding agent (Claude Code or similar). Hand it the whole file.

It is a specification plus a list of traps. The traps are the valuable part: each one was verified against the live API or the Cloudflare platform while building this, and most are invisible until a chart is quietly wrong.

---

## Prerequisites

Confirm the user has all of these before writing code:

- **An Android phone with Health Connect,** where the source apps (Samsung Health, Polar Flow, a scale app) write into Health Connect.
- **The Google Health app** (formerly Fitbit) on that phone, signed in with the target Google account and connected to Health Connect with read access. This app is the only bridge from the phone to Google's cloud.
- **A Cloudflare account with a domain on it,** for a custom hostname behind Cloudflare Access.
- **Optionally Pushover** for alerts.

**Probe before building.** Step 1 of the build order is a throwaway script that authorizes and lists recent data for every type. It shows which sources actually reach the API. If the user's sources are absent, stop: nothing below will help.

---

## 1. The goal

Long-term trends from wearable and scale data, in storage the user controls, refreshed daily.

**The resolution requirement is load-bearing: progression, not telemetry.** Keep enough to redraw a night's hypnogram and chart months of resting heart rate. Do not keep every sample in the Worker's database. That single decision is what lets everything fit in free tiers.

---

## 2. Hard constraints

- **Free tier.** Cloudflare Workers Free: 10 ms CPU per invocation (cron included), 50 subrequests per invocation, 100,000 requests a day. D1 Free: 100,000 rows written and 5 million rows read a day, 5 GB total. Free plans return errors instead of billing, so an overrun breaks a page silently.
- **Read-only Google access.** Request only the `.readonly` scopes. Never write to Google Health.
- **Fail closed.** If the Access configuration is missing, every data route answers 503. If the Access JWT is missing or invalid, answer 403. Never fall back to open.
- **No build step, no CDN at runtime.** Inline the dashboard; the Worker serves one HTML string and JSON.
- **One user.**

### Non-goals

Realtime data, multiple users, writing back to Google, medical alerts about the body, steps (until a reliable watch source exists), and the Polar H10 raw ECG path.

---

## 3. Architecture

```
Phone: Samsung Health / Polar Flow / scale app -> Health Connect -> Google Health app -> Google cloud

Cloudflare Worker
+-- scheduled()  twice a day
|     refresh token -> rollUp heart rate -> list sleep, exercise, weight, body fat
|     -> upsert D1 -> recompute resting HR -> log -> evaluate alerts -> Pushover
+-- fetch()      behind Cloudflare Access (JWT verified in the Worker)
      /            dashboard
      /api/*       summary, day, trends, health, settings, pull-now, test-notification, export.csv
      /about, /privacy   public pages Google requires to publish the OAuth app
```

**Every cron run is a cold isolate.** All state lives in D1.

**Every run re-reads an overlapping window** (the last 3 days, widened to 14 after a gap). Upserts are idempotent, so late-arriving data is absorbed without a watermark.

**History comes from a local script,** not the Worker. It pulls with the same ingest code, writes SQL files, and loads them with `wrangler d1 execute --file`. That sidesteps the Worker's CPU and subrequest limits.

### Module layout

```
src/ingest.js   API JSON -> rows, stage compaction, local dates. PURE
src/metrics.js  resting HR, sleep score, workout rules, trends, alert state machine. PURE
src/google.js   token refresh, paged list, rollUp, subrequest counter
src/pull.js     one pull end to end; never throws
src/views.js    JSON views, server-side downsampling
src/access.js   Access JWT verification
src/db.js       D1 helpers and upserts
src/notify.js   Pushover
src/ui.html     the page
```

Keep `ingest.js` and `metrics.js` free of I/O. The history backfill and the dataset exporter import them too, so there is one definition of a night, a resting heart rate and a duplicate workout.

---

## 4. Data model

```sql
hr_buckets (start_ts INTEGER PRIMARY KEY, min REAL, avg REAL, max REAL)          -- 15-minute rollUp
nights (id TEXT PRIMARY KEY, wake_date TEXT, start_ts, end_ts, source,
        deep_min, rem_min, light_min, awake_min, asleep_min,
        stages_json TEXT, updated_at)                                            -- [[offsetMin, lenMin, "d|r|l|a|s"], ...]
workouts (id TEXT PRIMARY KEY, type, name, start_ts, end_ts, active_s, avg_hr, max_hr, source)
body (id TEXT PRIMARY KEY, kind TEXT /* weight_g | fat_pct */, ts, value, source)
rhr_daily (date TEXT PRIMARY KEY, bpm REAL, night_id TEXT)
sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts, trigger, status, detail)
state (key TEXT PRIMARY KEY, value TEXT)                                        -- settings, alert states, meta
```

- **Store the source on every row from day one.** Health Connect merges every writing app, and the same phone step counter appears under two sources. Retrofitting source attribution means re-pulling everything.
- **Stages go in a JSON column, not a row per segment.** About 130 segments a night over eight years is roughly 400,000 rows, against 100,000 writes a day.
- **Retention is the inverse of a monitoring log.** The summaries are the record and are never pruned. Only `sync_log` is trimmed, to one year.
- **Upsert everything.** `max_hr` on workouts is derived after heart-rate buckets land, so an incoming NULL must not overwrite it (use `COALESCE`).

---

## 5. Derived values

- **Main night.** The longest session ending on a local date (`wake_date`). Naps must never replace the night.
- **Resting heart rate.** The lowest mean of two consecutive 15-minute bucket averages inside the main night. A missing bucket breaks the pair rather than bridging it, so a gap cannot manufacture a low value from two distant readings. It will not match Samsung's or Fitbit's figure; say so in the UI.
- **Sleep score (0 to 100).** Samsung does not publish its formula or share its score, so build an estimate from the factors Samsung names, as piecewise-linear sub-scores:
  - **Factors and weights:**

    | Factor | Weight | Full marks |
    |---|---|---|
    | Time asleep | 30 | 7.5 to 9 h |
    | Efficiency (asleep / in bed) | 15 | 93%+ |
    | Deep share of sleep | 15 | 18%+ |
    | REM share of sleep | 15 | 22%+ |
    | Awake after onset and wake-ups of 3+ min | 15 | the worse of the two sub-scores counts |
    | Sleep cycles | 10 | 4+, counted as REM episodes at least 20 minutes apart |

  - **Short sleep cap:** the score cannot exceed `40 + 0.6 × duration sub-score`. A well-structured four-hour night must not score well.
  - **Bands:** Excellent 88+, Good 75+, Fair 55+, Attention below.
  - **Calibration:** against nights the user's Samsung app has already labeled. Re-tune with a Samsung "Download personal data" export when available.
  - **Nights with no stage list** get no score. Old Fitbit "classic" nights record only asleep and restless, so they score low on deep and REM; flag or skip them.
- **Workouts.** Apply both rules at read time; stored rows stay untouched:
  1. **Duplicates:** drop a workout that overlaps a better source's workout of the same category by at least half of the shorter one. Rank: Polar Flow above Samsung Health above everything else.
  2. **Merge:** join consecutive same-category workouts no more than 10 minutes apart. Samsung auto-pause splits one ride into a new session at every traffic light. Sum the moving time, weight average heart rate by moving time, and take the max of the maxima.
- **Categories.** Anything containing SWIM is Swimming; BIK, CYCL or SPINNING is Biking; everything else is Other (walking dominates it).
- **Body readings.**
  - Drop a reading with the same kind and value as the previous one within 120 seconds. Observed: one weigh-in stored twice, 38 seconds apart.
  - Chart a 7-day rolling median over readings, with raw points underneath.
  - Mark source changes as bands: body fat from different scales is not comparable, and a jump at a boundary is the scale.

---

## 6. Alerts

Only about the pipeline, never about the body. Default settings, editable in the dashboard:

| Alert | Fires when |
|---|---|
| Watch data stopped | No new heart rate or sleep for 2 days |
| Daily pull failing | 2 failed runs in a row (not counted while access is lost) |
| Google access lost | The token refresh returns `invalid_grant`. Always on. |
| Data flowing again | Once, when a fired alert clears |

- **Record separately from delivery.** Write the state change unconditionally; keep it pending until a push succeeds. A Pushover outage must not erase the fact that data stopped.
- **Recovery needs a delivered fire.** Only a fire that was actually delivered earns a recovery message.
- **Quiet hours** (22:00 to 08:00 local) hold delivery. Schedule the crons outside them, so a run delivers what it finds.
- **Weight never alerts.** Weeks without weighing are normal.

---

## 7. The dashboard

Single page, mobile first, everything inlined. Order:

1. **Data status chips:** heart rate, sleep, workouts, weight, Google, pull. Short labels on one row, with tooltips explaining each state and what would change it.
   - Status colors mean one thing each: green OK, blue for information, grey not tracked, orange warning, red problem.
   - **Charts never use red or orange,** so those two always mean attention.
2. **Last night and today:** time asleep with the sleep label, stage hours and percentages, resting heart rate against its 30-day average, today's workouts (one line each with time range and heart rate).
3. **One day in detail**, with previous and next buttons:
   - **Hypnogram:** lanes bottom-up Deep, REM, Light, Awake.
   - **Heart rate:** 15-minute min/avg/max bands, shading for asleep and workouts.
   - **Workout list.**
4. **Trends** with one range control (1W, 1M, 3M, 1Y, All):
   - Sleep stacked by stage.
   - Resting heart rate with its 30-day average.
   - Weight and body fat with medians and scale-change bands.
   - Exercise minutes by type.
   - Steps as an explained empty state.
5. **Data health** (collapsed): coverage calendar, sources by year, sync log, Pull now, CSV export.
6. **Alerts** (collapsed): toggles, thresholds, quiet hours, a real "Send test notification" button.

**Downsample on the server.** Day grain up to 3 months, week for 1 year, month for All. Every chart gets a hover tooltip, and every chart color passes a color-blindness check against both themes.

---

## 8. Traps

### Google Health API (v4)

- **Service `health.googleapis.com`,** base `https://health.googleapis.com/v4/users/me/dataTypes/{type}/dataPoints`. Lists come back **newest first**.
- **Path ids use hyphens, filter prefixes use underscores:** `heart-rate` in the URL, `heart_rate.sample_time.physical_time >= "..."` in the filter.
- **Session types reject `interval.start_time` filters** (`INVALID_DATA_POINT_FILTER_DATA_TYPE_MEMBER`).
  - **Sleep:** accepts `sleep.interval.end_time >= "..."`.
  - **Exercise:** rejects every date filter. Page newest first and stop once past the window.
- **Heart rate must use `dataPoints:rollUp`.** Raw lists are thousands of points a day, too much for 10 ms.
  - **Limits:** both the range and `windowSize × pageSize` must stay within 14 days.
  - **Alignment:** buckets start at the range start, not on the clock. Align the range to 15 minutes, or buckets land at :07 and :22 and never match stored rows.
  - **Response fields:** `beatsPerMinuteAvg`, `beatsPerMinuteMax`, `beatsPerMinuteMin`.
- **Timestamps carry up to 6 or more fractional digits.** Parse defensively.
- **Sources.** Records synced from the phone have `dataSource.platform = HEALTH_CONNECT` and `application.packageName` naming the writer.
  - **Same pedometer twice:** `MobileTrack` (Google Health's phone counter) and `android` (the system counter) are the same steps with near-identical counts.
- **Samsung shares less than it records.** Samsung Health does not pass HRV, skin temperature, respiratory rate, resting heart rate, SpO2 or per-minute watch steps. Google's own help page lists this; the API confirms it. Plan the UI around their absence.
- **Data arrives only after the source app syncs.**
  - **Samsung:** an update left Samsung Health waiting to be opened, and nothing arrived for ten days. Everything backfilled once it ran.
  - **Polar Flow:** sessions appear only after Polar Flow syncs.
  - **Consequence:** the overlapping re-read window and the staleness alert are both mandatory.
- **Scale app timestamps can be wrong.** Arboleaf readings appeared several times a day on dates with no weigh-in at all. Keep them with their source and say so in the UI; do not trust them at day resolution.
- **Resolution.** 1-minute rollUp across all history is about four million rows for eight years of data. Fine for an offline export, far too much for the Worker.

### Google OAuth

- **Use a Web application client** with redirect URI `https://www.google.com`, exactly. The code comes back in the address bar; a local script exchanges it. The Worker uses the same client and refresh token.
- **Publish the app, or the refresh token dies after 7 days.** Publishing needs a homepage URL and a privacy-policy URL on the Branding page. The Publish button is greyed out without them; hover it for the reason.
- **Unverified apps are capped at 100 users.** Verification with a paid security assessment is only needed beyond that.
- **Scopes:** `googlehealth.activity_and_fitness.readonly`, `googlehealth.health_metrics_and_measurements.readonly`, `googlehealth.sleep.readonly`.

### Cloudflare

- **Verify the Access JWT in the Worker.** Header `cf-access-jwt-assertion`, RS256 against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. Check `aud`, `exp` and the allowed email. Do not trust a header Access merely forwards.
- **Close the side doors:** set `workers_dev: false` and `preview_urls: false`. Otherwise a workers.dev URL bypasses Access.
- **Public `/about` and `/privacy` need their own Access application** with a Bypass policy on those paths. Access protects the whole hostname, so Google's publishing check otherwise hits a login page.
- **The Access policy editor's Include row starts as a selector.** Choose "Emails" first, then type the address. Typing the address into the selector shows "No valid options".
- **On Windows, `wrangler d1 execute --command` breaks on quoting.** Use `--file`.
- **Default library user agents get HTTP 403 with `error code: 1010`** before reaching the Worker. Send a conventional `User-Agent` from scripts.
- **`Intl.DateTimeFormat` timezone math is too slow for 10 ms** across thousands of days. Cache the offset per month; test the cache against Intl across both DST changes.
- **The "All" trends range is the tightest CPU path.** Walk dates as integer day numbers, not date strings.
- **Upload secrets with `wrangler secret bulk`** from a temporary JSON file, then delete it. Secrets take a few seconds to reach the Worker.

### Notifications

- **Use Pushover, not ntfy.sh, from a Worker.** ntfy's free tier meters quota by IP address, and Workers send from shared addresses, so strangers exhaust it. The symptom is HTTP 429 after a handful of messages.

---

## 9. Build order

1. **Probe.** Authorize with a local script and list a week of every type. Check that the user's sources appear, and note which types are empty.
2. **Pure logic with tests,** before any plumbing: stage compaction, local dates across DST, resting heart rate with missing buckets, workout duplicate and merge rules, body dedupe and median, the alert state machine (fires once, recovers once, quiet hours hold then deliver, recording survives a failed push), and the JWT check rejecting a wrong `aud`, an expired token and an unsigned one.
3. **The pull and D1,** with the overlapping window and the subrequest counter.
4. **The dashboard,** against a local database loaded by the backfill script.
5. **Deploy:** D1, Access, secrets, history import, custom domain.
6. **Publish the OAuth app** within 7 days of the first token.
7. **Dataset export** for offline analysis, reusing the same pure modules.

---

## 10. Style notes

- **Comment the reasoning, not the mechanics.** "rollUp windows start at the range start" explains why the alignment line exists.
- **Comment the traps where they bite.** The next reader of the filter code needs to know `start_time` is rejected for sessions.
- **Never invent data.** A night with no watch has no sleep row; a gap stays a gap.
