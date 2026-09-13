-- Health Monitor D1 schema. Apply once:
--   npx wrangler d1 execute healthmon --remote --file=schema.sql
--
-- Retention is the inverse of Nest: the summaries below ARE the record and are
-- never pruned. Only sync_log is trimmed (one year).

-- 15-minute heart-rate buckets from the API's rollUp, epoch seconds UTC.
CREATE TABLE IF NOT EXISTS hr_buckets (
  start_ts INTEGER PRIMARY KEY,
  min REAL,
  avg REAL,
  max REAL
);

-- One row per sleep session. The main night for a wake_date is the longest.
-- stages_json: [[offsetMin, lenMin, "d|r|l|a|s"], ...] relative to start_ts.
-- Stored as JSON instead of one row per stage: ~130 segments a night over eight
-- years would be ~400k rows against a 100k writes/day free quota.
CREATE TABLE IF NOT EXISTS nights (
  id TEXT PRIMARY KEY,
  wake_date TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  offset_s INTEGER,             -- UTC offset of the night as recorded (travel-aware local times)
  source TEXT,
  deep_min REAL,
  rem_min REAL,
  light_min REAL,
  awake_min REAL,
  asleep_min REAL,
  stages_json TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS nights_wake ON nights (wake_date);

CREATE TABLE IF NOT EXISTS workouts (
  id TEXT PRIMARY KEY,
  type TEXT,
  name TEXT,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL,
  offset_s INTEGER,
  active_s REAL,
  avg_hr REAL,
  max_hr REAL,
  source TEXT
);
CREATE INDEX IF NOT EXISTS workouts_start ON workouts (start_ts);

-- kind: weight_g | fat_pct. Source is kept on every reading because body fat
-- from different scales is not comparable.
CREATE TABLE IF NOT EXISTS body (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ts INTEGER NOT NULL,
  offset_s INTEGER,
  value REAL NOT NULL,
  source TEXT
);
CREATE INDEX IF NOT EXISTS body_kind_ts ON body (kind, ts);

-- Lowest 30-minute average heart rate inside the main night, keyed by wake date.
-- Shown as "lowest sleeping heart rate": it runs below Samsung's sleeping HR and Fitbit resting HR.
CREATE TABLE IF NOT EXISTS rhr_daily (
  date TEXT PRIMARY KEY,
  bpm REAL,
  night_id TEXT
);

-- Samsung Health's daily step total (watch plus phone as Samsung counts them), one row per local day.
-- Days Samsung did not send stay absent: a gap is never a zero.
CREATE TABLE IF NOT EXISTS steps_daily (
  date TEXT PRIMARY KEY,
  steps INTEGER,
  source TEXT
);

-- Nightly values only Samsung's own "Download personal data" export carries, loaded by
-- tools/samsung_import.py. Keyed by local wake date.
CREATE TABLE IF NOT EXISTS samsung_nightly (
  wake_date TEXT PRIMARY KEY,
  sleep_score REAL,
  efficiency REAL,
  sleeping_hr REAL,
  sleeping_hrv REAL,
  skin_temp_delta REAL,
  respiratory_rate REAL,
  spo2_avg REAL,
  spo2_low_duration REAL,
  stress_avg REAL,
  source_note TEXT
);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  trigger TEXT,
  status TEXT,
  detail TEXT
);

-- settings, alerts (state machine), meta (failure counter, last results).
CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT
);
