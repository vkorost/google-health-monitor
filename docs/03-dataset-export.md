# Dataset export

`tools/export_dataset.py` pulls your whole Google Health record into `data/` (gitignored) for analysis elsewhere: pandas, a notebook, or another AI session. It reads the API only and changes nothing. It is independent of the Worker and D1, and needs only `.secrets/` from [docs/01-google-setup.md](01-google-setup.md).

```bash
python tools/export_dataset.py
```

- **Run time.** Expect tens of minutes on a multi-year account. Per-minute heart rate alone is one rollUp request per 6-day window from `HR_START` (2018-01-01 by default; edit the constant for less).
- **Resuming.** The script resumes: finished pulls in `data/raw/` are reused, so a re-run after an interruption continues where it stopped. The newest heart-rate window is always refreshed. Delete `data/raw/` for a completely fresh pull.
- **Local times.** `HEALTH_TZ` sets the fallback timezone for local-time columns (default `America/New_York`).
- **Requirements.** Python 3.11+ (standard library only) and Node 20+. Sleep sessions, sleep scores and combined workouts are computed by `tools/export_node.mjs` with the Worker's own `src/ingest.js` and `src/metrics.js`, so the dataset and the dashboard agree.

A thorough analysis starts with the data dictionary below. Copy this file into `data/README.md` if the analysis runs somewhere without the repo.

## Files

| Path | What it is |
|---|---|
| `health.sqlite` | All tables below in one SQLite database. Best for SQL or `pd.read_sql`. |
| `csv/<table>.csv` | The same tables, one CSV each, with a header row |
| `raw/<type>.ndjson.gz` | Every data point exactly as the API returned it, one JSON object per line |
| `raw/heart_rate_1min/*.json` | The heart-rate rollUp responses, one file per 6-day window |
| `manifest.json` | Export time, row counts per table, date ranges, per-type pull results |

## Conventions

- **Times.** Every `*_utc` column is ISO 8601 UTC. `*_local` and `local_date` columns are wall-clock local time, computed two ways:
  - **Record offset** (respects travel): `workouts`, `body`, `measurements`, `activity_hourly`.
  - **Fixed `HEALTH_TZ`**: `sleep_sessions`, `sleep_stages`, `heart_rate_1min`. The rollUp heart-rate data carries no offset, and sleep uses the same zone as the dashboard.
  - Outside travel the two agree; while traveling, sleep and heart rate stay on home time.
- **Dates.** `local_date` is the local calendar date of the start. `wake_date` on sleep is the local date the session ended.
- **Sources.** `source` is the app package that wrote the record, or the device name when there is none. `sources.csv` lists every source per type with first and last dates.

| Source | Meaning |
|---|---|
| `com.sec.android.app.shealth` | Samsung Health (watch and phone), via Health Connect |
| `fi.polar.polarflow` | Polar Flow, for example Polar H10 sessions recorded in Polar Beat |
| `com.qingniu.arboleaf` | Arboleaf smart scale app |
| `android` | Android system step counter on the phone |
| `MobileTrack` | The Google Health / Fitbit app counting steps with the phone |
| `Versa`, `Versa 4`, `Aria`, ... | Fitbit devices, for accounts with Fitbit history |
| `FITBIT_WEB_API` | Records written into Fitbit by a third-party app |

## Tables

### `heart_rate_1min`
Per-minute heart rate from the API's rollUp across all sources.

| Column | Meaning |
|---|---|
| `start_utc`, `start_local`, `local_date` | Start of the minute |
| `bpm_min`, `bpm_avg`, `bpm_max` | Beats per minute within that minute |

Minutes with no reading are absent, not zero. Sources are merged by Google in the rollUp; when a chest strap and a watch both record, both are included.

### `sleep_sessions`
One row per sleep session, naps included.

| Column | Meaning |
|---|---|
| `is_main_night` | 1 for the longest session ending on that `wake_date`. Use it to get one night per date. |
| `in_bed_min` | Session start to end |
| `asleep_min`, `deep_min`, `rem_min`, `light_min`, `awake_min` | Minutes per stage |
| `has_stages` | 0 for old Fitbit "classic" nights recorded only as asleep or restless |
| `sleep_score`, `sleep_label` | Estimate and label (see "Derived values") |
| `efficiency_pct`, `deep_pct`, `rem_pct`, `awake_after_onset_min`, `wakeups`, `cycles` | Factors behind the score |
| `resting_hr_bpm` | Resting heart rate for main nights (see "Derived values") |

### `sleep_stages`
Every stage segment: `session_id` (joins to `sleep_sessions.id`), `stage` (`deep`, `rem`, `light`, `awake`, `asleep_unstaged`), start, end, `minutes`. Adjacent segments of the same stage are merged.

### `workouts`
Every exercise session as recorded.

| Column | Meaning |
|---|---|
| `type` | The API's exercise type (`BIKING`, `SWIMMING`, `WALKING`, ...) |
| `category` | Swimming, Biking or Other |
| `elapsed_min` | Start to end |
| `active_min` | Moving time reported by the app |
| `avg_hr_reported` | Average heart rate the app reported |
| `avg_hr_1min`, `max_hr_1min` | Computed from `heart_rate_1min` over the session |
| `hidden_as_duplicate` | 1 when a Polar workout of the same category overlaps this one by at least half of the shorter one. The dashboard shows only the Polar session. |
| `metrics_json` | The full exercise object minus its interval |

### `workouts_combined`
Workouts as the dashboard shows them: duplicates removed, and consecutive same-category workouts no more than 10 minutes apart joined into one. `segments` counts the joined sessions, `active_min` sums their moving time, and `avg_hr_reported` is weighted by moving time.

### `body`
Weight and body-fat readings.

| Column | Meaning |
|---|---|
| `kind` | `weight` (`value` in grams, plus `weight_lb`) or `body_fat` (`value` in percent) |
| `is_repeat_write` | 1 when the same value was written again within 120 seconds |

### `daily_resting_hr_computed`
One row per `wake_date`: resting heart rate and the night it came from.

### `measurements`
Every other sample or daily type in long format: one row per numeric field per record.

| Column | Meaning |
|---|---|
| `type` | The API data type |
| `field` | Dotted path inside the record |
| `value` | Numeric value |
| `text_value` | Set instead of `value` for non-numeric fields |

It includes the vendors' daily summaries (`daily-resting-heart-rate`, `daily-heart-rate-variability`, `daily-oxygen-saturation`, `daily-respiratory-rate`, `daily-sleep-temperature-derivations`, `daily-vo2-max`, `daily-heart-rate-zones`) and samples such as `oxygen-saturation`, `heart-rate-variability`, `respiratory-rate-sleep-summary`, `vo2-max` and `height`. Pivot on `type` and `field`.

### `activity_hourly`
Per-minute activity types summed per local hour, per source and field:
- `steps`, `distance`, `active-energy-burned`
- `active-minutes`, `active-zone-minutes`, `activity-level`, `sedentary-period`
- `altitude`, `time-in-heart-rate-zone`, `swim-lengths-data`

`records` is how many raw records went into the cell. Originals are in `raw/`.

**Field naming:**
- **Numeric fields** keep their name and are summed: `count` for steps, `strokeCount`, and so on.
- **Label fields** become minutes per label, named `<field>=<label> (minutes)`, for example `activityLevelType=SEDENTARY (minutes)`. This covers `activity-level`, `time-in-heart-rate-zone` and the zone labels in `active-minutes`.
- **Records with no fields at all** (`sedentary-period`) count as `minutes`.

Check the distinct `field` values per `type` before analyzing.

### `sources`
Every source per type: platform, device, first and last dates, record count.

## Derived values

- **Sleep score.** An estimate, not Samsung's score, which is neither published nor shared.
  - **Weights:** time asleep 30, efficiency 15, deep share 15, REM share 15, awake time and wake-ups after onset 15, sleep cycles 10.
  - **Short sleep cap:** at most `40 + 0.6 × duration sub-score`.
  - **Labels:** Excellent 88+, Good 75+, Fair 55+, Attention below.
  - **Formula:** `sleepScore` in `src/metrics.js`.
- **Resting heart rate.** The lowest mean of two consecutive 15-minute bucket averages inside the main night. Each bucket is the mean of its 1-minute averages and needs 8 of 15 minutes present. The dashboard uses Google's own 15-minute rollUp, so values can differ slightly. Neither matches the vendors' figures, which are in `measurements`.

## Known data problems

- **Samsung does not share everything with Health Connect.**
  - **Missing:** HRV, skin temperature, respiratory rate, resting heart rate, and per-reading SpO2. Values for those come from Fitbit-era history (to 2023) or Polar.
  - **Shared as daily summaries only:** SpO2 (`daily-oxygen-saturation`: average, lower bound, upper bound, standard deviation) and steps (one daily total per day). Minute-level values of either are not shared.
  - **Samsung-only metrics:** stress, HRV and body composition exist only in Samsung Health's own "Download personal data" export.
- **Sleep stages from different devices are not comparable.** Treat a device change as a break in any stage trend.
- **Steps are unreliable.**
  - **Same counter twice:** the phone's counter appears as both `MobileTrack` and `android` with near-identical counts. Never sum them.
  - **Phone counts miss days:** they undercount every day the phone stays behind.
  - **Watch steps are daily totals with gaps:** Samsung Health writes one daily total per day, which can be missing for weeks without being backfilled. The hourly cell holding it is the hour the total was written. Use it at day resolution only.
- **Within-minute heart-rate spread is Fitbit-only.** In the Samsung era about 97% of minutes have one sample (`bpm_min = bpm_max`), so `bpm_min`/`bpm_max` spread is meaningful only for Fitbit years and Polar sessions.
- **Scale app timestamps can be wrong.** Arboleaf readings have appeared several times a day on dates with no weigh-in. Check against the scale app before trusting dates at day resolution.
- **Body fat is not comparable across scales.** Different electrodes, frequencies and equations. Analyze each source separately.
- **Workouts are split and duplicated.** Samsung auto-pause creates several sessions per ride, and chest-strap sessions duplicate watch sessions. Use `workouts_combined` for counts and totals.
- **Late arrival.** Data reaches Google only when the source app syncs. A stalled app update can leave a multi-day gap that fills in later, so a recent gap may not be permanent.
- **Missing values are absent rows.** Minutes without heart rate are absent from `heart_rate_1min`, and nights without the watch have no sleep session.
