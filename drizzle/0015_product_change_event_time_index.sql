CREATE INDEX IF NOT EXISTS idx_product_change_events_owner_time
  ON product_change_events (owner_id, observed_at DESC);
