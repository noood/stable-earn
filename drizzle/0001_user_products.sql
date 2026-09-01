CREATE TABLE IF NOT EXISTS product_override_limits (
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  first_tier_limit REAL CHECK (first_tier_limit IS NULL OR first_tier_limit > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_product_override_limits_user_id
ON product_override_limits (user_id);

CREATE TABLE IF NOT EXISTS product_override_terms (
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  term_days REAL CHECK (term_days IS NULL OR (term_days > 0 AND term_days <= 3650)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_product_override_terms_user_id
ON product_override_terms (user_id);

CREATE TABLE IF NOT EXISTS user_products (
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  asset TEXT NOT NULL CHECK (asset IN ('USDT', 'USDC', 'USDGO', 'BTC')),
  product_kind TEXT NOT NULL CHECK (product_kind IN ('flexible', 'fixed', 'limited')),
  term_days REAL CHECK (term_days IS NULL OR (term_days > 0 AND term_days <= 3650)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_user_products_user_id
ON user_products (user_id);

PRAGMA optimize;
