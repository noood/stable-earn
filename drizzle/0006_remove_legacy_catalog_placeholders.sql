CREATE TABLE IF NOT EXISTS legacy_catalog_cleanup_0006 (
  owner_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  PRIMARY KEY (owner_id, product_id)
);

DELETE FROM legacy_catalog_cleanup_0006;

-- Older releases inserted all 22 normalization/demo seeds into every user's
-- catalogue. Select only rows that were never replaced by verified API data
-- or made meaningful by a real holding/manual configuration.
INSERT INTO legacy_catalog_cleanup_0006 (owner_id, product_id)
SELECT catalog.owner_id, catalog.product_id
FROM product_catalog AS catalog
WHERE catalog.status = 'active'
  AND json_valid(catalog.payload)
  AND (
    catalog.product_id = 'by-eu-usdc'
    OR (
      json_extract(catalog.payload, '$.productDataMode') = 'api'
      AND (
        COALESCE(json_extract(catalog.payload, '$.source.kind'), '') <> 'live'
        OR COALESCE(json_extract(catalog.payload, '$.rateCoverage'), 'unavailable') = 'unavailable'
      )
    )
    OR (
      (
        -- These two oldest placeholders predate productDataMode/rateCoverage.
        catalog.product_id IN ('by-g-usdt', 'bg-usdgo')
        OR (
          json_extract(catalog.payload, '$.productDataMode') = 'manual'
          AND COALESCE(json_extract(catalog.payload, '$.rateCoverage'), 'unavailable') = 'unavailable'
        )
      )
      AND COALESCE((
        SELECT holding.amount
        FROM holdings AS holding
        WHERE holding.user_id = catalog.owner_id
          AND holding.product_id = catalog.product_id
      ), 0) <= 0
      AND NOT EXISTS (
        SELECT 1
        FROM product_overrides AS product_override
        WHERE product_override.user_id = catalog.owner_id
          AND product_override.product_id = catalog.product_id
          AND (
            product_override.confirmed_apr > 0
            OR TRIM(COALESCE(product_override.purchase_date, '')) <> ''
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM product_override_limits AS product_limit
        WHERE product_limit.user_id = catalog.owner_id
          AND product_limit.product_id = catalog.product_id
          AND product_limit.first_tier_limit > 0
      )
      AND NOT EXISTS (
        SELECT 1
        FROM product_override_terms AS product_term
        WHERE product_term.user_id = catalog.owner_id
          AND product_term.product_id = catalog.product_id
          AND product_term.term_days > 0
      )
    )
  );

UPDATE product_catalog
SET status = 'archived',
    archived_at = CURRENT_TIMESTAMP,
    last_seen_at = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1
  FROM legacy_catalog_cleanup_0006 AS cleanup
  WHERE cleanup.owner_id = product_catalog.owner_id
    AND cleanup.product_id = product_catalog.product_id
);

DELETE FROM hidden_products
WHERE EXISTS (
  SELECT 1
  FROM legacy_catalog_cleanup_0006 AS cleanup
  WHERE cleanup.owner_id = hidden_products.user_id
    AND cleanup.product_id = hidden_products.product_id
);

DELETE FROM hidden_seed_products
WHERE EXISTS (
  SELECT 1
  FROM legacy_catalog_cleanup_0006 AS cleanup
  WHERE cleanup.owner_id = hidden_seed_products.user_id
    AND cleanup.product_id = hidden_seed_products.product_id
);

DELETE FROM sync_snapshots
WHERE cache_key = 'private-products'
  AND owner_id IN (SELECT DISTINCT owner_id FROM legacy_catalog_cleanup_0006);

DROP TABLE legacy_catalog_cleanup_0006;

PRAGMA optimize;
