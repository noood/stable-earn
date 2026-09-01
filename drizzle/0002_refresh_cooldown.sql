CREATE TABLE user_settings_next (
  user_id TEXT PRIMARY KEY,
  manual_refresh_cooldown_minutes INTEGER NOT NULL DEFAULT 30
    CHECK (manual_refresh_cooldown_minutes IN (0, 30)),
  updated_at TEXT NOT NULL
);

INSERT INTO user_settings_next (user_id, manual_refresh_cooldown_minutes, updated_at)
SELECT
  user_id,
  CASE WHEN manual_refresh_cooldown_minutes = 0 THEN 0 ELSE 30 END,
  updated_at
FROM user_settings;

DROP TABLE user_settings;
ALTER TABLE user_settings_next RENAME TO user_settings;

PRAGMA optimize;
