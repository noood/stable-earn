-- Preserve every old catalog identity before changing manual rows to the
-- account:asset:type:manual:slug format. This migration is additive and can
-- be inspected or rolled back before the legacy column is removed.
CREATE TABLE IF NOT EXISTS product_identity_aliases (
  owner_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  product_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, alias)
);

CREATE INDEX IF NOT EXISTS idx_product_identity_aliases_product
  ON product_identity_aliases (owner_id, product_id);

INSERT OR IGNORE INTO product_identity_aliases (owner_id, alias, product_id, created_at)
SELECT owner_id, canonical_product_id, product_id, CURRENT_TIMESTAMP
FROM product_catalog
WHERE TRIM(canonical_product_id) <> '';

INSERT OR IGNORE INTO product_identity_aliases (owner_id, alias, product_id, created_at)
SELECT owner_id, identity_key, product_id, CURRENT_TIMESTAMP
FROM product_catalog
WHERE TRIM(identity_key) <> '';

-- Only rows explicitly marked manual are changed. API rows without a verified
-- external product id are intentionally left alone for manual review.
UPDATE product_catalog
SET identity_key = json_extract(payload, '$.accountId') || ':'
    || UPPER(json_extract(payload, '$.asset')) || ':'
    || LOWER(COALESCE(json_extract(payload, '$.productType'), 'flexible'))
    || ':manual:' || substr(product_id, 8),
    canonical_product_id = json_extract(payload, '$.accountId') || ':'
    || UPPER(json_extract(payload, '$.asset')) || ':'
    || LOWER(COALESCE(json_extract(payload, '$.productType'), 'flexible'))
    || ':manual:' || substr(product_id, 8),
    payload = json_set(payload, '$.identityKey',
      json_extract(payload, '$.accountId') || ':'
      || UPPER(json_extract(payload, '$.asset')) || ':'
      || LOWER(COALESCE(json_extract(payload, '$.productType'), 'flexible'))
      || ':manual:' || substr(product_id, 8))
WHERE json_valid(payload)
  AND json_extract(payload, '$.productDataMode') = 'manual'
  AND TRIM(COALESCE(json_extract(payload, '$.accountId'), '')) <> ''
  AND TRIM(COALESCE(json_extract(payload, '$.asset'), '')) <> '';

INSERT OR IGNORE INTO product_identity_aliases (owner_id, alias, product_id, created_at)
SELECT owner_id, identity_key, product_id, CURRENT_TIMESTAMP
FROM product_catalog
WHERE TRIM(identity_key) <> '';
