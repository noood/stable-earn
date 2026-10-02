CREATE TABLE IF NOT EXISTS product_change_events (
  owner_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('rate', 'capacity', 'holding', 'maturity', 'availability')),
  title TEXT NOT NULL,
  before_value TEXT,
  after_value TEXT,
  observed_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('定时刷新', '手动刷新', '每日首次打开', '手动编辑')),
  attention INTEGER NOT NULL DEFAULT 0 CHECK (attention IN (0, 1)),
  PRIMARY KEY (owner_id, event_id)
);
