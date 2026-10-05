-- Store the per-user cooldown after an exchange rate-limits the read-only API
-- capability check. Timestamps are Unix milliseconds; no API response or
-- account/holding data is stored here.
CREATE TABLE IF NOT EXISTS capability_probe_cooldowns (
  user_id TEXT PRIMARY KEY,
  cooldown_until INTEGER NOT NULL DEFAULT 0
);
