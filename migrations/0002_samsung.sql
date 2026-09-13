-- 0002: travel-aware offsets, Samsung daily steps, Samsung export nightly values.
--
-- Apply with wrangler's migration tracking, which runs each file once:
--   npx wrangler d1 migrations apply healthmon --remote
-- SQLite has no ADD COLUMN IF NOT EXISTS, so the ALTERs below are safe only through
-- that tracking (or on a database created from an older schema.sql). A database
-- created from the current schema.sql already has these columns: mark this
-- migration applied instead of running it.

ALTER TABLE nights ADD COLUMN offset_s INTEGER;
ALTER TABLE workouts ADD COLUMN offset_s INTEGER;
ALTER TABLE body ADD COLUMN offset_s INTEGER;

CREATE TABLE IF NOT EXISTS steps_daily (
  date TEXT PRIMARY KEY,
  steps INTEGER,
  source TEXT
);

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
