-- Apply once, before deploying readers of first_tier_unlimited. NULL preserves
-- legacy inheritance; 0 is an explicit limited/pending choice; 1 is unlimited.
-- The ALTER is not rerunnable. Do not rerun the backfill after user edits.
ALTER TABLE product_override_limits ADD COLUMN first_tier_unlimited INTEGER
  CHECK (first_tier_unlimited IN (0, 1))
  CHECK (first_tier_unlimited IS NOT 1 OR first_tier_limit IS NULL);

-- Previous BGW releases stored the user's unlimited assumption in the catalog,
-- not in overrides. Preserve only that explicit, account-scoped old state.
-- Include archived rows so disconnecting/reconnecting does not erase it.
WITH old_bgw_unlimited AS (
  SELECT c.owner_id AS user_id, c.product_id, c.last_seen_at AS updated_at
  FROM product_catalog c
  LEFT JOIN product_override_limits l
    ON l.user_id = c.owner_id AND l.product_id = c.product_id
  WHERE json_valid(c.payload)
    AND json_extract(c.payload, '$.accountId') = 'bitget-wallet-morph'
    AND json_extract(c.payload, '$.productDataMode') = 'manual'
    AND json_array_length(c.payload, '$.tiers') = 1
    AND json_type(c.payload, '$.tiers[0].max') = 'null'
    AND json_extract(c.payload, '$.tiers[0].maxStatus') = 'unlimited'
    AND json_extract(c.payload, '$.capacityStatus') = 'available'
    AND l.first_tier_limit IS NULL AND l.first_tier_unlimited IS NULL
)
INSERT OR IGNORE INTO product_overrides (user_id, product_id, updated_at)
SELECT user_id, product_id, updated_at FROM old_bgw_unlimited;

WITH old_bgw_unlimited AS (
  SELECT c.owner_id AS user_id, c.product_id, c.last_seen_at AS updated_at
  FROM product_catalog c
  WHERE json_valid(c.payload)
    AND json_extract(c.payload, '$.accountId') = 'bitget-wallet-morph'
    AND json_extract(c.payload, '$.productDataMode') = 'manual'
    AND json_array_length(c.payload, '$.tiers') = 1
    AND json_type(c.payload, '$.tiers[0].max') = 'null'
    AND json_extract(c.payload, '$.tiers[0].maxStatus') = 'unlimited'
    AND json_extract(c.payload, '$.capacityStatus') = 'available'
)
INSERT INTO product_override_limits
  (user_id, product_id, first_tier_limit, first_tier_unlimited, updated_at)
SELECT user_id, product_id, NULL, 1, updated_at FROM old_bgw_unlimited WHERE true
ON CONFLICT(user_id, product_id) DO UPDATE SET first_tier_unlimited = 1
WHERE product_override_limits.first_tier_limit IS NULL
  AND product_override_limits.first_tier_unlimited IS NULL;
