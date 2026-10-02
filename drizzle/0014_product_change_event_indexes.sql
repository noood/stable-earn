CREATE INDEX IF NOT EXISTS idx_product_change_events_owner_product_time
  ON product_change_events (owner_id, product_id, observed_at DESC);
