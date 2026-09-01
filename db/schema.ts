export const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS holdings (
    user_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0 CHECK (amount >= 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, product_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_holdings_user_id
    ON holdings (user_id)`,
  `CREATE TABLE IF NOT EXISTS product_overrides (
    user_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    confirmed_apr REAL CHECK (confirmed_apr IS NULL OR (confirmed_apr >= 0 AND confirmed_apr <= 10000)),
    purchase_date TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, product_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_product_overrides_user_id
    ON product_overrides (user_id)`,
  `CREATE TABLE IF NOT EXISTS product_override_limits (
    user_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    first_tier_limit REAL CHECK (first_tier_limit IS NULL OR first_tier_limit > 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, product_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_product_override_limits_user_id
    ON product_override_limits (user_id)`,
  `CREATE TABLE IF NOT EXISTS product_override_terms (
    user_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    term_days REAL CHECK (term_days IS NULL OR (term_days > 0 AND term_days <= 3650)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, product_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_product_override_terms_user_id
    ON product_override_terms (user_id)`,
  `CREATE TABLE IF NOT EXISTS user_products (
    user_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    asset TEXT NOT NULL CHECK (asset IN ('USDT', 'USDC', 'USDGO', 'BTC')),
    product_kind TEXT NOT NULL CHECK (product_kind IN ('flexible', 'fixed', 'limited')),
    term_days REAL CHECK (term_days IS NULL OR (term_days > 0 AND term_days <= 3650)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, product_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_user_products_user_id
    ON user_products (user_id)`,
  `CREATE TABLE IF NOT EXISTS hidden_seed_products (
    user_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    hidden_at TEXT NOT NULL,
    PRIMARY KEY (user_id, product_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hidden_seed_products_user_id
    ON hidden_seed_products (user_id)`,
  `CREATE TABLE IF NOT EXISTS exchange_credentials (
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, account_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_exchange_credentials_user_id
    ON exchange_credentials (user_id)`,
  `CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY,
    manual_refresh_cooldown_minutes INTEGER NOT NULL DEFAULT 30
      CHECK (manual_refresh_cooldown_minutes IN (0, 30)),
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rate_snapshots (
    product_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sync_snapshots (
    owner_id TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    payload TEXT,
    updated_at TEXT,
    last_attempt_at TEXT,
    last_manual_at TEXT,
    last_error TEXT,
    PRIMARY KEY (owner_id, cache_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sync_snapshots_updated_at
    ON sync_snapshots (updated_at)`,
  `CREATE TABLE IF NOT EXISTS product_catalog (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_product_catalog_owner_status
    ON product_catalog (owner_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_product_catalog_owner_canonical
    ON product_catalog (owner_id, canonical_product_id)`,
  `CREATE TABLE IF NOT EXISTS hidden_products (
    user_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    hidden_at TEXT NOT NULL,
    PRIMARY KEY (user_id, product_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hidden_products_user_id
    ON hidden_products (user_id)`,
] as const;
