CREATE TABLE IF NOT EXISTS hidden_seed_products (
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  hidden_at TEXT NOT NULL,
  PRIMARY KEY (user_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_hidden_seed_products_user_id
ON hidden_seed_products (user_id);

PRAGMA optimize;
