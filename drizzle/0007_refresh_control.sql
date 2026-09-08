CREATE TABLE IF NOT EXISTS refresh_control (
  user_id TEXT PRIMARY KEY,
  daily_day TEXT,
  scheduled_done_at INTEGER,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
