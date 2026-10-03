ALTER TABLE product_change_events ADD COLUMN read_at TEXT;

UPDATE product_change_events
SET read_at = observed_at
WHERE attention = 1 AND read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_product_change_events_unread_attention
  ON product_change_events (owner_id, product_id, observed_at DESC)
  WHERE attention = 1 AND read_at IS NULL;
