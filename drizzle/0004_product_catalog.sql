CREATE TABLE IF NOT EXISTS product_catalog (
  owner_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  canonical_product_id TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  identity_fingerprint TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  archived_at TEXT,
  PRIMARY KEY (owner_id, product_id),
  UNIQUE (owner_id, identity_key, identity_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_product_catalog_owner_status
ON product_catalog (owner_id, status);

CREATE INDEX IF NOT EXISTS idx_product_catalog_owner_canonical
ON product_catalog (owner_id, canonical_product_id);

CREATE TABLE IF NOT EXISTS hidden_products (
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  hidden_at TEXT NOT NULL,
  PRIMARY KEY (user_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_hidden_products_user_id
ON hidden_products (user_id);

PRAGMA optimize;
