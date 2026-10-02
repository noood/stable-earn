-- Replace API product-family aliases with the platform identity:
--   accountId:ASSET:productType:externalProductId
--
-- product_catalog.product_id is deliberately kept as the durable database
-- row id. Only the matching identity columns and embedded payload identity are
-- changed, so holdings, overrides and hidden state can follow the same row.
-- Manual products (manual-*) are not candidates for this migration.

DROP TABLE IF EXISTS catalog_identity_migration_0010;

CREATE TABLE catalog_identity_migration_0010 AS
WITH candidates AS (
  SELECT
    catalog.owner_id,
    catalog.product_id,
    catalog.identity_fingerprint,
    catalog.status,
    catalog.payload,
    TRIM(COALESCE(json_extract(catalog.payload, '$.accountId'), '')) AS account_id,
    UPPER(TRIM(COALESCE(json_extract(catalog.payload, '$.asset'), ''))) AS asset,
    LOWER(TRIM(COALESCE(json_extract(catalog.payload, '$.productType'), 'flexible'))) AS product_type,
    COALESCE(
      NULLIF(TRIM(COALESCE(json_extract(catalog.payload, '$.externalProductId'), '')), ''),
      (
        SELECT NULLIF(TRIM(COALESCE(json_extract(rate.value, '$.externalProductId'), '')), '')
        FROM sync_snapshots AS snapshot, json_each(json_extract(snapshot.payload, '$.rates')) AS rate
        WHERE snapshot.owner_id = catalog.owner_id
          AND snapshot.cache_key = 'private-products'
          AND json_extract(rate.value, '$.productId') = catalog.product_id
        LIMIT 1
      ),
      NULLIF(CASE WHEN INSTR(catalog.identity_key, ':') > 0
        THEN SUBSTR(catalog.identity_key, INSTR(catalog.identity_key, ':') + 1)
        ELSE ''
      END, '')
    ) AS external_product_id
  FROM product_catalog AS catalog
  WHERE json_valid(catalog.payload)
    AND (
      json_extract(catalog.payload, '$.productDataMode') = 'api'
      OR json_extract(catalog.payload, '$.source.kind') IN ('live', 'private')
      OR (
        json_extract(catalog.payload, '$.holdingDataMode') = 'api'
        AND EXISTS (
          SELECT 1
          FROM sync_snapshots AS snapshot, json_each(json_extract(snapshot.payload, '$.rates')) AS rate
          WHERE snapshot.owner_id = catalog.owner_id
            AND snapshot.cache_key = 'private-products'
            AND json_extract(rate.value, '$.productId') = catalog.product_id
            AND NULLIF(TRIM(COALESCE(json_extract(rate.value, '$.externalProductId'), '')), '') IS NOT NULL
        )
      )
    )
), identities AS (
  SELECT
    owner_id,
    product_id,
    identity_fingerprint,
    status,
    payload,
    account_id,
    asset,
    product_type,
    external_product_id,
    account_id || ':' || asset || ':' || product_type || ':' || external_product_id AS target_identity
  FROM candidates
  WHERE account_id <> ''
    AND asset <> ''
    AND product_type IN ('flexible', 'fixed')
    AND external_product_id <> ''
), ranked AS (
  SELECT
    identities.*,
    ROW_NUMBER() OVER (
      PARTITION BY owner_id, target_identity
      ORDER BY
        CASE WHEN status = 'active' THEN 0 ELSE 1 END,
        CASE WHEN COALESCE((SELECT amount FROM holdings
          WHERE holdings.user_id = identities.owner_id
            AND holdings.product_id = identities.product_id), 0) > 0 THEN 0 ELSE 1 END,
        CASE WHEN EXISTS (SELECT 1 FROM product_overrides
          WHERE product_overrides.user_id = identities.owner_id
            AND product_overrides.product_id = identities.product_id
            AND (TRIM(COALESCE(product_overrides.purchase_date, '')) <> ''
              OR product_overrides.confirmed_apr IS NOT NULL)) THEN 0 ELSE 1 END,
        product_id
    ) AS rank_no
  FROM identities
)
SELECT * FROM ranked;

-- Move every user reference from a duplicate target identity to its winner.
INSERT INTO holdings (user_id, product_id, amount, updated_at)
SELECT migration.owner_id, migration.winner_product_id, SUM(holding.amount), CURRENT_TIMESTAMP
FROM (
  SELECT loser.owner_id, loser.product_id AS loser_product_id, winner.product_id AS winner_product_id
  FROM catalog_identity_migration_0010 AS loser
  JOIN catalog_identity_migration_0010 AS winner
    ON winner.owner_id = loser.owner_id
   AND winner.target_identity = loser.target_identity
   AND winner.rank_no = 1
  WHERE loser.rank_no > 1
) AS migration
JOIN holdings AS holding
  ON holding.user_id = migration.owner_id
 AND holding.product_id = migration.loser_product_id
GROUP BY migration.owner_id, migration.winner_product_id
ON CONFLICT(user_id, product_id) DO UPDATE SET
  amount = holdings.amount + excluded.amount,
  updated_at = excluded.updated_at;

INSERT INTO holding_positions
  (user_id, product_id, position_key, amount, purchase_at, redeem_at, source, updated_at)
SELECT loser.owner_id, winner.product_id, position.position_key,
       position.amount, position.purchase_at, position.redeem_at, position.source, CURRENT_TIMESTAMP
FROM catalog_identity_migration_0010 AS loser
JOIN catalog_identity_migration_0010 AS winner
  ON winner.owner_id = loser.owner_id
 AND winner.target_identity = loser.target_identity
 AND winner.rank_no = 1
JOIN holding_positions AS position
  ON position.user_id = loser.owner_id
 AND position.product_id = loser.product_id
WHERE loser.rank_no > 1
ON CONFLICT(user_id, product_id, position_key) DO UPDATE SET
  amount = holding_positions.amount + excluded.amount,
  purchase_at = COALESCE(holding_positions.purchase_at, excluded.purchase_at),
  redeem_at = COALESCE(holding_positions.redeem_at, excluded.redeem_at),
  source = excluded.source,
  updated_at = excluded.updated_at;

INSERT OR IGNORE INTO product_overrides
  (user_id, product_id, confirmed_apr, purchase_date, eligibility_confirmed, updated_at)
SELECT loser.user_id, winner.product_id, loser.confirmed_apr, loser.purchase_date,
       loser.eligibility_confirmed, CURRENT_TIMESTAMP
FROM catalog_identity_migration_0010 AS loser_map
JOIN catalog_identity_migration_0010 AS winner
  ON winner.owner_id = loser_map.owner_id
 AND winner.target_identity = loser_map.target_identity
 AND winner.rank_no = 1
JOIN product_overrides AS loser
  ON loser.user_id = loser_map.owner_id
 AND loser.product_id = loser_map.product_id
WHERE loser_map.rank_no > 1;

UPDATE product_overrides AS winner
SET confirmed_apr = COALESCE(winner.confirmed_apr, (
      SELECT MAX(loser.confirmed_apr)
      FROM product_overrides AS loser
      JOIN catalog_identity_migration_0010 AS loser_map
        ON loser_map.owner_id = loser.user_id
       AND loser_map.product_id = loser.product_id
      JOIN catalog_identity_migration_0010 AS winner_map
        ON winner_map.owner_id = loser_map.owner_id
       AND winner_map.target_identity = loser_map.target_identity
       AND winner_map.rank_no = 1
      WHERE loser_map.rank_no > 1
        AND winner_map.owner_id = winner.user_id
        AND winner_map.product_id = winner.product_id
    )),
    purchase_date = COALESCE(NULLIF(winner.purchase_date, ''), (
      SELECT MAX(NULLIF(loser.purchase_date, ''))
      FROM product_overrides AS loser
      JOIN catalog_identity_migration_0010 AS loser_map
        ON loser_map.owner_id = loser.user_id
       AND loser_map.product_id = loser.product_id
      JOIN catalog_identity_migration_0010 AS winner_map
        ON winner_map.owner_id = loser_map.owner_id
       AND winner_map.target_identity = loser_map.target_identity
       AND winner_map.rank_no = 1
      WHERE loser_map.rank_no > 1
        AND winner_map.owner_id = winner.user_id
        AND winner_map.product_id = winner.product_id
    )),
    eligibility_confirmed = COALESCE(winner.eligibility_confirmed, (
      SELECT MAX(loser.eligibility_confirmed)
      FROM product_overrides AS loser
      JOIN catalog_identity_migration_0010 AS loser_map
        ON loser_map.owner_id = loser.user_id
       AND loser_map.product_id = loser.product_id
      JOIN catalog_identity_migration_0010 AS winner_map
        ON winner_map.owner_id = loser_map.owner_id
       AND winner_map.target_identity = loser_map.target_identity
       AND winner_map.rank_no = 1
      WHERE loser_map.rank_no > 1
        AND winner_map.owner_id = winner.user_id
        AND winner_map.product_id = winner.product_id
    )),
    updated_at = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1 FROM catalog_identity_migration_0010 AS winner_map
  WHERE winner_map.owner_id = winner.user_id
    AND winner_map.product_id = winner.product_id
    AND winner_map.rank_no = 1
);

INSERT OR IGNORE INTO product_override_limits (user_id, product_id, first_tier_limit, updated_at)
SELECT loser.user_id, winner.product_id, loser.first_tier_limit, CURRENT_TIMESTAMP
FROM catalog_identity_migration_0010 AS loser_map
JOIN catalog_identity_migration_0010 AS winner
  ON winner.owner_id = loser_map.owner_id
 AND winner.target_identity = loser_map.target_identity
 AND winner.rank_no = 1
JOIN product_override_limits AS loser
  ON loser.user_id = loser_map.owner_id
 AND loser.product_id = loser_map.product_id
WHERE loser_map.rank_no > 1;

UPDATE product_override_limits AS winner
SET first_tier_limit = COALESCE(winner.first_tier_limit, (
      SELECT MAX(loser.first_tier_limit)
      FROM product_override_limits AS loser
      JOIN catalog_identity_migration_0010 AS loser_map
        ON loser_map.owner_id = loser.user_id
       AND loser_map.product_id = loser.product_id
      JOIN catalog_identity_migration_0010 AS winner_map
        ON winner_map.owner_id = loser_map.owner_id
       AND winner_map.target_identity = loser_map.target_identity
       AND winner_map.rank_no = 1
      WHERE loser_map.rank_no > 1
        AND winner_map.owner_id = winner.user_id
        AND winner_map.product_id = winner.product_id
    )),
    updated_at = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1 FROM catalog_identity_migration_0010 AS winner_map
  WHERE winner_map.owner_id = winner.user_id
    AND winner_map.product_id = winner.product_id
    AND winner_map.rank_no = 1
);

INSERT OR IGNORE INTO product_override_terms (user_id, product_id, term_days, updated_at)
SELECT loser.user_id, winner.product_id, loser.term_days, CURRENT_TIMESTAMP
FROM catalog_identity_migration_0010 AS loser_map
JOIN catalog_identity_migration_0010 AS winner
  ON winner.owner_id = loser_map.owner_id
 AND winner.target_identity = loser_map.target_identity
 AND winner.rank_no = 1
JOIN product_override_terms AS loser
  ON loser.user_id = loser_map.owner_id
 AND loser.product_id = loser_map.product_id
WHERE loser_map.rank_no > 1;

UPDATE product_override_terms AS winner
SET term_days = COALESCE(winner.term_days, (
      SELECT MAX(loser.term_days)
      FROM product_override_terms AS loser
      JOIN catalog_identity_migration_0010 AS loser_map
        ON loser_map.owner_id = loser.user_id
       AND loser_map.product_id = loser.product_id
      JOIN catalog_identity_migration_0010 AS winner_map
        ON winner_map.owner_id = loser_map.owner_id
       AND winner_map.target_identity = loser_map.target_identity
       AND winner_map.rank_no = 1
      WHERE loser_map.rank_no > 1
        AND winner_map.owner_id = winner.user_id
        AND winner_map.product_id = winner.product_id
    )),
    updated_at = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1 FROM catalog_identity_migration_0010 AS winner_map
  WHERE winner_map.owner_id = winner.user_id
    AND winner_map.product_id = winner.product_id
    AND winner_map.rank_no = 1
);

INSERT OR IGNORE INTO hidden_products (user_id, product_id, hidden_at)
SELECT loser.owner_id, winner.product_id, CURRENT_TIMESTAMP
FROM catalog_identity_migration_0010 AS loser
JOIN catalog_identity_migration_0010 AS winner
  ON winner.owner_id = loser.owner_id
 AND winner.target_identity = loser.target_identity
 AND winner.rank_no = 1
JOIN hidden_products AS hidden
  ON hidden.user_id = loser.owner_id
 AND hidden.product_id = loser.product_id
WHERE loser.rank_no > 1;

INSERT OR IGNORE INTO user_products
  (user_id, product_id, account_id, asset, product_kind, term_days, created_at, updated_at)
SELECT loser.user_id, winner.product_id, loser.account_id, loser.asset, loser.product_kind,
       loser.term_days, loser.created_at, CURRENT_TIMESTAMP
FROM catalog_identity_migration_0010 AS loser_map
JOIN catalog_identity_migration_0010 AS winner
  ON winner.owner_id = loser_map.owner_id
 AND winner.target_identity = loser_map.target_identity
 AND winner.rank_no = 1
JOIN user_products AS loser
  ON loser.user_id = loser_map.owner_id
 AND loser.product_id = loser_map.product_id
WHERE loser_map.rank_no > 1;

-- Remove loser references after all values have been copied.
DELETE FROM holdings
WHERE EXISTS (
  SELECT 1 FROM catalog_identity_migration_0010 AS loser
  WHERE loser.owner_id = holdings.user_id
    AND loser.product_id = holdings.product_id
    AND loser.rank_no > 1
);

DELETE FROM holding_positions
WHERE EXISTS (
  SELECT 1 FROM catalog_identity_migration_0010 AS loser
  WHERE loser.owner_id = holding_positions.user_id
    AND loser.product_id = holding_positions.product_id
    AND loser.rank_no > 1
);

DELETE FROM product_overrides
WHERE EXISTS (
  SELECT 1 FROM catalog_identity_migration_0010 AS loser
  WHERE loser.owner_id = product_overrides.user_id
    AND loser.product_id = product_overrides.product_id
    AND loser.rank_no > 1
);

DELETE FROM product_override_limits
WHERE EXISTS (
  SELECT 1 FROM catalog_identity_migration_0010 AS loser
  WHERE loser.owner_id = product_override_limits.user_id
    AND loser.product_id = product_override_limits.product_id
    AND loser.rank_no > 1
);

DELETE FROM product_override_terms
WHERE EXISTS (
  SELECT 1 FROM catalog_identity_migration_0010 AS loser
  WHERE loser.owner_id = product_override_terms.user_id
    AND loser.product_id = product_override_terms.product_id
    AND loser.rank_no > 1
);

DELETE FROM hidden_products
WHERE EXISTS (
  SELECT 1 FROM catalog_identity_migration_0010 AS loser
  WHERE loser.owner_id = hidden_products.user_id
    AND loser.product_id = hidden_products.product_id
    AND loser.rank_no > 1
);

DELETE FROM user_products
WHERE EXISTS (
  SELECT 1 FROM catalog_identity_migration_0010 AS loser
  WHERE loser.owner_id = user_products.user_id
    AND loser.product_id = user_products.product_id
    AND loser.rank_no > 1
);

-- Put rows in a temporary identity namespace first so a duplicate target key
-- cannot violate product_catalog's UNIQUE(owner_id, identity_key, fingerprint).
UPDATE product_catalog
SET canonical_product_id = 'migration-0010:' || owner_id || ':' || product_id,
    identity_key = 'migration-0010:' || owner_id || ':' || product_id
WHERE EXISTS (
  SELECT 1 FROM catalog_identity_migration_0010 AS migration
  WHERE migration.owner_id = product_catalog.owner_id
    AND migration.product_id = product_catalog.product_id
);

UPDATE product_catalog
SET canonical_product_id = migration.target_identity,
    identity_key = migration.target_identity,
    payload = json_set(product_catalog.payload, '$.identityKey', migration.target_identity)
FROM catalog_identity_migration_0010 AS migration
WHERE migration.owner_id = product_catalog.owner_id
  AND migration.product_id = product_catalog.product_id
  AND migration.rank_no = 1;

UPDATE product_catalog
SET canonical_product_id = 'legacy-0010:' || migration.product_id,
    identity_key = 'legacy-0010:' || migration.product_id,
    payload = json_set(product_catalog.payload, '$.identityKey', 'legacy-0010:' || migration.product_id),
    status = 'archived',
    archived_at = COALESCE(product_catalog.archived_at, CURRENT_TIMESTAMP),
    last_seen_at = CURRENT_TIMESTAMP
FROM catalog_identity_migration_0010 AS migration
WHERE migration.owner_id = product_catalog.owner_id
  AND migration.product_id = product_catalog.product_id
  AND migration.rank_no > 1;

-- Cached payloads contain old adapter IDs. The next refresh rebuilds the
-- payload using the new identities; deleting the cache cannot delete holdings.
DELETE FROM sync_snapshots WHERE cache_key = 'private-products';

DROP TABLE catalog_identity_migration_0010;
PRAGMA optimize;
