# Google Health Monitor

**Your watch, your chest strap and your scale each keep their own app. This puts the long-term record in one place you control.**

It is a personal dashboard for health data that reaches Google Health: a Samsung Galaxy Watch through Samsung Health, Polar sessions through Polar Flow, smart-scale readings through their vendor apps, and any older Fitbit history on the same Google account. A Cloudflare Worker pulls it twice a day, stores summaries in D1, and serves a dashboard behind Google sign-in. It charts how nights are structured, how resting heart rate moves over months, and where weight is trending. It is built for progression, not telemetry.

It runs on Cloudflare's free tier and costs nothing to operate.

---

## Before you read further: what has to be true

**You need all of these:**

| | |
|---|---|
| **A Google account with the Google Health app** | The Android app formerly called Fitbit. It is what copies phone-side Health Connect data into Google's cloud. |
| **Health Connect on an Android phone** | Samsung Health, Polar Flow or your scale's app must be allowed to write into it, and the Google Health app must be allowed to read from it. |
| **A Cloudflare account with a domain** | The dashboard lives on a custom hostname behind Cloudflare Access. |
| **Pushover (optional)** | For the "data stopped arriving" alerts. $4.99 once per platform. |

**This is for you if** you wear a Samsung watch (or anything else that writes to Health Connect), you want years of sleep, heart-rate and weight trends somewhere other than a vendor app, and you are comfortable running `wrangler`.

**This is not for you if** you want realtime data, multiple users, or anything that writes back into Google Health. None of those are goals.

Screenshots are not included: every screen shows a real person's health record.

---

## Why this architecture

Every obvious route to the data is closed:

- **Samsung Health has no personal cloud API.** Its SDK is Android-only and gated behind a partner program.
- **The Google Fit REST API is gone.** Signups closed in May 2024 and it was turned down in June 2025.
- **The Fitbit Web API is being turned down in September 2026,** and new developer accounts are no longer issued.
- **Health Connect is not a cloud service.** It is an on-device store gated by Android permissions, with nothing on a server to poll.

The route that works is the **Google Health API (v4)**. The Google Health app on the phone reads Health Connect and syncs what it finds to your Google account. The API then returns it with the writing app attached to every record, for example `dataSource.application.packageName = "com.sec.android.app.shealth"`. That lets a Worker pull, on a schedule, data that otherwise never leaves the phone.

The catch: data reaches Google only when the source apps sync. A Samsung Health update that sat unopened stopped everything for ten days, which is why "data stopped arriving" is the one alert that always matters.

---

## What it costs

| | |
|---|---|
| Google Health API | **$0**. No billing account needed. |
| Cloudflare Workers, D1, Access (up to 50 users) | **$0** on the free tiers |
| Pushover | **$4.99 once**, optional |

Two things to know:

- **Google's paid security review does not apply.** The Google Health API's scopes are "restricted", and verification (with a third-party security assessment) is only required to go beyond 100 users. A single-user app runs unverified.
- **The OAuth app must be published.** While it stays in "Testing", Google expires the refresh token every 7 days and the Worker loses access weekly. Publishing needs a homepage and a privacy-policy URL; the Worker serves both at `/about` and `/privacy`.

The free Worker plan allows 10 ms of CPU per request. Heart rate is pulled pre-summarized through the API's `rollUp` endpoint, and long ranges are downsampled on the server, so every path fits.

---

## What you get

- **Data status.** A row of chips shows when each source last delivered: heart rate, sleep, workouts, weight, Google access and the last pull. Hover for what each one means.
- **Last night and today.** Time asleep, with hours and percentages for Deep, REM, Light and Awake; a sleep label (Excellent, Good, Fair, Attention); resting heart rate against its 30-day average; today's workouts.
- **One day in detail.** A hypnogram, heart rate through the day in 15-minute min/avg/max bands with sleep and workouts shaded, and the workout list.
- **Trends.** Sleep by stage, resting heart rate, weight and body fat (each with a 7-day rolling median and scale-change bands), and exercise minutes by type, over 1W, 1M, 3M, 1Y or All.
- **Data health.** A 26-week coverage calendar, which device supplied each metric when, a sync log, a "Pull now" button and CSV export.
- **Alerts about the pipeline, not about your body.** Pushover messages when watch data stops arriving, the pull keeps failing, or Google access is lost, plus one message when data flows again. Quiet hours hold them overnight.
- **A dataset exporter.** `tools/export_dataset.py` pulls the whole record (per-minute heart rate for every year the account holds, every sleep stage, every workout and reading) into CSV files, a SQLite database and a data dictionary, ready for analysis elsewhere.

Workouts are cleaned up for display without touching the stored rows. Samsung's auto-pause splits one ride into a new session at every traffic light, so same-type sessions under 10 minutes apart show as one. When a Polar chest-strap session covers the same activity, it replaces the watch's segments.

---

## Getting started

Roughly two hours, most of it in Google's and Cloudflare's consoles.

1. **[Google setup](docs/01-google-setup.md)** covers the phone-side prerequisites, the Google Cloud project, OAuth, and a first probe that shows which of your sources actually reach the API.
2. **[Deploy to Cloudflare](docs/02-cloudflare-deploy.md)** covers D1, Cloudflare Access with Google sign-in, secrets, the history import, and the first pull.
3. **[Dataset export](docs/03-dataset-export.md)** covers pulling the full record for offline analysis.

---

## What is in here

```
src/             the Cloudflare Worker
  index.js         router, cron entry, public /about and /privacy
  pull.js          one pull: Google -> D1 -> resting HR -> alerts
  google.js        Google Health API client (heart rate only via rollUp)
  ingest.js        API records -> rows, stage compaction, local dates. Pure
  metrics.js       resting HR, sleep score, workout merging, trends, alert state machine. Pure
  views.js         JSON for the dashboard, downsampled server side
  access.js        Cloudflare Access JWT verification, fails closed
  db.js, notify.js D1 helpers, Pushover
  ui.html, ui.js   the dashboard, no CDN and no build step
  icons.js         app icons, generated by tools/make_icon.py
test/            node --test, no database or network
tools/           OAuth bootstrap and probe, history backfill, dataset export, icon generator
docs/            setup guides
schema.sql       D1 schema
ASSIGNMENT.md    a complete brief for rebuilding this from scratch with an AI agent
```

```bash
npm test
```

---

## Limits

- **It shows only what Samsung shares.** Samsung Health does not pass HRV, skin temperature, respiratory rate, resting heart rate, SpO2 or minute-level watch steps to Health Connect. Resting heart rate is calculated here from overnight heart rate; the others are simply absent.
- **The sleep label is an estimate.** Samsung does not publish its sleep-score formula or share the score. This one uses the factors Samsung names and is tuned by hand; it will disagree on some nights.
- **Steps are not charted.** Only the phone's pedometer reliably reaches Google, and it undercounts every day the phone stays behind.
- **One person.** Multi-user support is a deliberate non-goal.

---

## Built with Claude Code

Built in a single working session with Claude Code, starting from a research brief and a probe of what the Google Health API actually returns for a Samsung setup. [`ASSIGNMENT.md`](ASSIGNMENT.md) is the complete brief for reproducing it: architecture, derived-metric definitions, and the traps that cost time.

## Licence

MIT. See [LICENSE](LICENSE).
