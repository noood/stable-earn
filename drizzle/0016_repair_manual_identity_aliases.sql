-- Repair manual catalog identities created before the account:asset:type:manual:slug
-- format was introduced. 0011 used substr(product_id, 8), which is correct for
-- manual-xxxxxxxx ids but produces malformed slugs for legacy seed ids such as
-- mexc-ph-usdt and okx-usdt.
--
-- This migration is deliberately additive. The durable product_id and all
-- foreign-key references remain unchanged. The old identity remains resolvable
-- through product_identity_aliases.

CREATE TABLE IF NOT EXISTS product_identity_aliases (
  owner_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  product_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, alias)
);

CREATE INDEX IF NOT EXISTS idx_product_identity_aliases_product
  ON product_identity_aliases (owner_id, product_id);

DROP TABLE IF EXISTS manual_identity_repair_0016;

CREATE TABLE manual_identity_repair_0016 AS
WITH source AS (
  SELECT
    owner_id,
    product_id,
    identity_key AS old_identity,
    payload,
    LOWER(TRIM(COALESCE(json_extract(payload, '$.accountId'), ''))) AS account_id,
    UPPER(TRIM(COALESCE(json_extract(payload, '$.asset'), ''))) AS asset,
    LOWER(TRIM(COALESCE(json_extract(payload, '$.productType'), 'flexible'))) AS product_type,
    LOWER(TRIM(product_id)) AS lower_product_id
  FROM product_catalog
  WHERE json_valid(payload)
    AND json_extract(payload, '$.productDataMode') = 'manual'
    AND TRIM(COALESCE(json_extract(payload, '$.accountId'), '')) <> ''
    AND TRIM(COALESCE(json_extract(payload, '$.asset'), '')) <> ''
), slugged AS (
  SELECT
    *,
    CASE
      -- All pre-manual-* catalog rows are built-in seed products. Each seed
      -- account/asset pair represents its default manual product; the old
      -- migration's substr(product_id, 8) created truncated slugs instead.
      WHEN lower_product_id NOT LIKE 'manual-%' THEN 'default'
      WHEN lower_product_id LIKE 'manual-%' THEN
        TRIM(REPLACE(REPLACE(REPLACE(REPLACE(SUBSTR(lower_product_id, 8), '_', '-'), ' ', '-'), ':', '-'), '/', '-'), '-')
      ELSE
        TRIM(REPLACE(REPLACE(REPLACE(REPLACE(lower_product_id, '_', '-'), ' ', '-'), ':', '-'), '/', '-'), '-')
    END AS raw_slug
  FROM source
), targets AS (
  SELECT
    owner_id,
    product_id,
    old_identity,
    payload,
    account_id || ':' || asset || ':' || product_type || ':manual:'
      || COALESCE(NULLIF(raw_slug, ''), 'legacy') AS target_identity
  FROM slugged
)
SELECT owner_id, product_id, old_identity, payload, target_identity
FROM targets
WHERE old_identity <> target_identity
   OR COALESCE(json_extract(payload, '$.identityKey'), '') <> target_identity;

-- Preserve the identity that was used by the old cache/catalog rows.
INSERT OR IGNORE INTO product_identity_aliases (owner_id, alias, product_id, created_at)
SELECT owner_id, old_identity, product_id, CURRENT_TIMESTAMP
FROM manual_identity_repair_0016
WHERE TRIM(old_identity) <> '';

-- Do not silently merge two rows if a manually chosen slug already exists.
-- Such a collision remains visible for manual review instead of changing a
-- user's references or balances.
UPDATE product_catalog
SET identity_key = (
      SELECT target_identity
      FROM manual_identity_repair_0016 AS repair
      WHERE repair.owner_id = product_catalog.owner_id
        AND repair.product_id = product_catalog.product_id
    ),
    payload = json_set(payload, '$.identityKey', (
      SELECT target_identity
      FROM manual_identity_repair_0016 AS repair
      WHERE repair.owner_id = product_catalog.owner_id
        AND repair.product_id = product_catalog.product_id
    ))
WHERE EXISTS (
    SELECT 1
    FROM manual_identity_repair_0016 AS repair
    WHERE repair.owner_id = product_catalog.owner_id
      AND repair.product_id = product_catalog.product_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM product_catalog AS conflict
    JOIN manual_identity_repair_0016 AS repair
      ON repair.owner_id = product_catalog.owner_id
     AND repair.product_id = product_catalog.product_id
     AND conflict.identity_key = repair.target_identity
    WHERE conflict.owner_id = product_catalog.owner_id
      AND conflict.product_id <> product_catalog.product_id
      AND COALESCE(conflict.identity_fingerprint, '') = COALESCE(product_catalog.identity_fingerprint, '')
  );

INSERT OR IGNORE INTO product_identity_aliases (owner_id, alias, product_id, created_at)
SELECT owner_id, target_identity, product_id, CURRENT_TIMESTAMP
FROM manual_identity_repair_0016;

DROP TABLE manual_identity_repair_0016;
