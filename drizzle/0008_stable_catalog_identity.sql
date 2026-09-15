-- Stable catalog identity and durable API position timing.
-- Run this migration once against the deployed D1 database. It is safe to
-- run after the application has already created the table via db/schema.ts.

CREATE TABLE IF NOT EXISTS holding_positions (
  user_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  position_key TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0 CHECK (amount >= 0),
  purchase_at TEXT,
  redeem_at TEXT,
  source TEXT NOT NULL CHECK (source IN ('api', 'manual')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, product_id, position_key)
);

CREATE INDEX IF NOT EXISTS idx_holding_positions_user_id
  ON holding_positions (user_id);

-- Existing releases could create two rows when a mutable subscription window
-- changed. Keep the best row (active + held + dated, then oldest), move user
-- data to it, and archive the duplicate. This is deliberately identity-key
-- based and therefore applies to every exchange, not only Binance.
--
-- D1 does not authorize TEMP tables, so use a regular migration-only helper
-- table and remove it at the end of the migration.
DROP TABLE IF EXISTS catalog_identity_merge;
CREATE TABLE catalog_identity_merge AS
WITH ranked AS (
  SELECT catalog.owner_id,
         catalog.product_id,
         catalog.identity_key,
         ROW_NUMBER() OVER (
           PARTITION BY catalog.owner_id, catalog.identity_key
           ORDER BY
             CASE WHEN catalog.status = 'active' THEN 0 ELSE 1 END,
             CASE WHEN COALESCE((SELECT amount FROM holdings
               WHERE holdings.user_id = catalog.owner_id
                 AND holdings.product_id = catalog.product_id), 0) > 0 THEN 0 ELSE 1 END,
             CASE WHEN EXISTS (SELECT 1 FROM product_overrides
               WHERE product_overrides.user_id = catalog.owner_id
                 AND product_overrides.product_id = catalog.product_id
                 AND TRIM(COALESCE(product_overrides.purchase_date, '')) <> '') THEN 0 ELSE 1 END,
             catalog.first_seen_at,
             catalog.product_id
         ) AS rank_no
  FROM product_catalog AS catalog
)
SELECT loser.owner_id,
       loser.product_id AS loser_product_id,
       winner.product_id AS winner_product_id
FROM ranked AS loser
JOIN ranked AS winner
  ON winner.owner_id = loser.owner_id
 AND winner.identity_key = loser.identity_key
 AND winner.rank_no = 1
WHERE loser.rank_no > 1;

INSERT INTO holdings (user_id, product_id, amount, updated_at)
SELECT merge.owner_id, merge.winner_product_id, SUM(holding.amount), CURRENT_TIMESTAMP
FROM catalog_identity_merge AS merge
JOIN holdings AS holding
  ON holding.user_id = merge.owner_id
 AND holding.product_id = merge.loser_product_id
GROUP BY merge.owner_id, merge.winner_product_id
ON CONFLICT(user_id, product_id) DO UPDATE SET
  amount = holdings.amount + excluded.amount,
  updated_at = excluded.updated_at;

INSERT OR IGNORE INTO product_overrides
  (user_id, product_id, confirmed_apr, purchase_date, updated_at)
SELECT loser.user_id,
       merge.winner_product_id,
       loser.confirmed_apr,
       loser.purchase_date,
       CURRENT_TIMESTAMP
FROM product_overrides AS loser
JOIN catalog_identity_merge AS merge
  ON merge.owner_id = loser.user_id
 AND merge.loser_product_id = loser.product_id
WHERE NOT EXISTS (
  SELECT 1 FROM product_overrides AS existing
  WHERE existing.user_id = loser.user_id
    AND existing.product_id = merge.winner_product_id
);

INSERT OR IGNORE INTO product_override_limits
  (user_id, product_id, first_tier_limit, updated_at)
SELECT loser.user_id, merge.winner_product_id, loser.first_tier_limit, CURRENT_TIMESTAMP
FROM product_override_limits AS loser
JOIN catalog_identity_merge AS merge
  ON merge.owner_id = loser.user_id
 AND merge.loser_product_id = loser.product_id
WHERE NOT EXISTS (
  SELECT 1 FROM product_override_limits AS existing
  WHERE existing.user_id = loser.user_id
    AND existing.product_id = merge.winner_product_id
);

INSERT OR IGNORE INTO product_override_terms
  (user_id, product_id, term_days, updated_at)
SELECT loser.user_id, merge.winner_product_id, loser.term_days, CURRENT_TIMESTAMP
FROM product_override_terms AS loser
JOIN catalog_identity_merge AS merge
  ON merge.owner_id = loser.user_id
 AND merge.loser_product_id = loser.product_id
WHERE NOT EXISTS (
  SELECT 1 FROM product_override_terms AS existing
  WHERE existing.user_id = loser.user_id
    AND existing.product_id = merge.winner_product_id
);

UPDATE product_overrides AS winner
SET purchase_date = COALESCE(NULLIF(winner.purchase_date, ''), (
      SELECT MAX(NULLIF(loser.purchase_date, ''))
      FROM product_overrides AS loser
      JOIN catalog_identity_merge AS merge
        ON merge.owner_id = loser.user_id
       AND merge.loser_product_id = loser.product_id
      WHERE merge.winner_product_id = winner.product_id
        AND merge.owner_id = winner.user_id
    )),
    confirmed_apr = COALESCE(winner.confirmed_apr, (
      SELECT MAX(loser.confirmed_apr)
      FROM product_overrides AS loser
      JOIN catalog_identity_merge AS merge
        ON merge.owner_id = loser.user_id
       AND merge.loser_product_id = loser.product_id
      WHERE merge.winner_product_id = winner.product_id
        AND merge.owner_id = winner.user_id
    )),
    updated_at = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1 FROM catalog_identity_merge AS merge
  WHERE merge.owner_id = winner.user_id
    AND merge.winner_product_id = winner.product_id
);

UPDATE product_override_limits AS winner
SET first_tier_limit = COALESCE(winner.first_tier_limit, (
      SELECT MAX(loser.first_tier_limit)
      FROM product_override_limits AS loser
      JOIN catalog_identity_merge AS merge
        ON merge.owner_id = loser.user_id
       AND merge.loser_product_id = loser.product_id
      WHERE merge.winner_product_id = winner.product_id
        AND merge.owner_id = winner.user_id
    )),
    updated_at = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1 FROM catalog_identity_merge AS merge
  WHERE merge.owner_id = winner.user_id
    AND merge.winner_product_id = winner.product_id
);

UPDATE product_override_terms AS winner
SET term_days = COALESCE(winner.term_days, (
      SELECT MAX(loser.term_days)
      FROM product_override_terms AS loser
      JOIN catalog_identity_merge AS merge
        ON merge.owner_id = loser.user_id
       AND merge.loser_product_id = loser.product_id
      WHERE merge.winner_product_id = winner.product_id
        AND merge.owner_id = winner.user_id
    )),
    updated_at = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1 FROM catalog_identity_merge AS merge
  WHERE merge.owner_id = winner.user_id
    AND merge.winner_product_id = winner.product_id
);

INSERT OR IGNORE INTO hidden_products (user_id, product_id, hidden_at)
SELECT owner_id, winner_product_id, CURRENT_TIMESTAMP
FROM catalog_identity_merge AS merge
WHERE EXISTS (
  SELECT 1 FROM hidden_products
  WHERE hidden_products.user_id = merge.owner_id
    AND hidden_products.product_id = merge.loser_product_id
);

DELETE FROM hidden_products
WHERE EXISTS (
  SELECT 1 FROM catalog_identity_merge AS merge
  WHERE merge.owner_id = hidden_products.user_id
    AND merge.loser_product_id = hidden_products.product_id
);

DELETE FROM holdings
WHERE EXISTS (
  SELECT 1 FROM catalog_identity_merge AS merge
  WHERE merge.owner_id = holdings.user_id
    AND merge.loser_product_id = holdings.product_id
);

UPDATE product_catalog
SET status = 'archived',
    archived_at = CURRENT_TIMESTAMP,
    last_seen_at = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1 FROM catalog_identity_merge AS merge
  WHERE merge.owner_id = product_catalog.owner_id
    AND merge.loser_product_id = product_catalog.product_id
);

-- Cached payloads contain product IDs, so rebuild them after the merge.
DELETE FROM sync_snapshots
WHERE cache_key = 'private-products';

DROP TABLE catalog_identity_merge;
PRAGMA optimize;
