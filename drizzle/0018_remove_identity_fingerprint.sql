-- Remove the obsolete product identity fingerprint while preserving every
-- durable catalog row id and all references from holdings/settings/history.
-- Run after 0012_remove_canonical_product_id.sql.
--
-- Do not add UNIQUE(owner_id, identity_key): older schemas allowed duplicate
-- identity keys distinguished by fingerprints (and SQLite treats NULLs as
-- distinct). Keep all such rows intact; runtime matching is identity-key based.
CREATE TABLE product_catalog_without_identity_fingerprint (
  owner_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  archived_at TEXT,
  PRIMARY KEY (owner_id, product_id)
);

INSERT INTO product_catalog_without_identity_fingerprint
  (owner_id, product_id, identity_key, payload, status, first_seen_at, last_seen_at, archived_at)
SELECT owner_id, product_id, identity_key, payload, status, first_seen_at, last_seen_at, archived_at
FROM product_catalog;

DROP TABLE product_catalog;
ALTER TABLE product_catalog_without_identity_fingerprint RENAME TO product_catalog;

CREATE INDEX IF NOT EXISTS idx_product_catalog_owner_status
  ON product_catalog (owner_id, status);
CREATE INDEX IF NOT EXISTS idx_product_catalog_owner_identity
  ON product_catalog (owner_id, identity_key);
