# Samsung Health export

**Health Connect does not carry everything Samsung records. This imports Samsung Health's own export to fill the gaps and add what Google never receives.**

Where both sources have data they agree closely, but Google's copy can miss whole months of watch data, most older workouts and weeks of step totals. It also never carries Samsung's sleep score, sleeping heart rate and HRV, skin temperature, respiratory rate, SpO2 or stress. The export has all of it.

Run this once after setup, and again whenever you want to refresh (quarterly is plenty). It is manual: Samsung offers no schedule and no API for the export.

---

## Step 1: Request the export

1. On the phone, open **Samsung Health**, then the three-dot menu, **Settings**, **Download personal data**.
2. Confirm with your Samsung account. Samsung prepares the files; a large history can take a few minutes.
3. The export lands in the phone's storage under `Samsung Health/Download/` as a folder of CSV files plus a `jsons/` tree.
4. Copy that folder to your computer and put its contents in `data/samsung_export/` in this repo. `data/` is gitignored; never commit it.

## Step 2: Build the import files

From the repo root:

```bash
python tools/samsung_import.py                  # 12 months of heart-rate buckets, everything else in full
python tools/samsung_import.py --hr-days 90     # less heart-rate history
```

Options: `--export <folder>` (default `data/samsung_export`), `--out <folder>` (default `import/samsung`).

It writes `import/samsung/NN-*.sql` and prints the row writes per file. Every statement is guarded:

| Table | What it fills |
|---|---|
| `nights` | Sessions Google lacks, with stages. Sessions Samsung split and linked by `combined_id` are joined. A night that overlaps a Health Connect night by half of the shorter one is skipped. |
| `workouts` | Workouts Google lacks, by the same overlap rule. Often most of the older bike and walk history. |
| `hr_buckets` | 15-minute heart rate only where the database has none, within the retention window. |
| `rhr_daily` | Lowest sleeping heart rate for the nights added. |
| `steps_daily` | Samsung's daily step totals for days Google lacks. |
| `samsung_nightly` | Samsung's own sleep score, efficiency, sleeping HR and HRV, skin temperature change against the previous 30 nights, respiratory rate, SpO2, low-SpO2 duration and mean stress. Replaced on every import. |

Imported rows carry the source `samsung_export`, so they never collide with Google's and can be removed with one `DELETE`.

## Step 3: Apply them

The database needs migration 0002 first (see [02-cloudflare-deploy.md](02-cloudflare-deploy.md)). Then, in file order:

```bash
for f in import/samsung/*.sql; do npx wrangler d1 execute healthmon --remote --file="$f"; done
```

```powershell
Get-ChildItem import\samsung\*.sql | Sort-Object Name | ForEach-Object { npx wrangler d1 execute healthmon --remote --file=$($_.FullName) }
```

A first import is typically under 40,000 row writes, inside the free plan's 100,000 a day. If the script reports more, apply the files across two days. Re-running an import changes nothing it already added.

## Step 4: Check the dashboard

- **Last night** shows Samsung's own score and label for imported nights, and "estimate" otherwise.
- **One day in detail** shows Samsung's nightly values for imported nights.
- **Trends** gain Samsung cards (sleeping HRV, skin temperature, respiratory rate, SpO2, stress) once there is data.
- **Data health** shows the date of the last import.

## Optional: refit the sleep-score estimate

The estimate used for nights without a Samsung score is fitted against Samsung's scores. The shipped constants came from one person's nights; refit them on yours:

```bash
python tools/fit_sleep_score.py                                         # report only
python tools/fit_sleep_score.py --google data/raw/sleep.ndjson.gz       # also score Google-delivered nights
python tools/fit_sleep_score.py --write                                 # update SLEEP_MODEL in src/metrics.js
```

Inputs: the export folder (nights, stages and Samsung's score) and, optionally, the raw sleep file from the [dataset export](03-dataset-export.md). It holds out one night in five, prints only aggregate statistics (correlation, mean error, label agreement before and after), and with `--write` replaces the constants between the `fitted` markers. Deploy afterwards.

## Known quirks

- **Codes.** Sleep stages: 40001 awake, 40002 light, 40003 deep, 40004 REM. Exercise types: 1001 walking, 1002 running, 11007 biking, 14001 swimming; others count as Other.
- **Times** are UTC with a per-row `time_offset`; imported nights keep their own offset, so travel shows local time.
- **Label cutoffs are not in the export.** Samsung shows labels but publishes no score bands; the dashboard's bands are a setting.
- **Vendor algorithm changes** show up as steps in nightly values (HRV and SpO2 in particular). Record known dates in the `trend_breaks` setting so the charts mark them.
