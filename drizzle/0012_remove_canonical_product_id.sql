-- Run only after 0011 and after the new Worker has been deployed. The
-- runtime now uses identity_key and product_identity_aliases; this removes
-- the obsolete product-family column without changing durable product_id
-- foreign keys or user balances.
INSERT OR IGNORE INTO product_identity_aliases (owner_id, alias, product_id, created_at)
SELECT owner_id, canonical_product_id, product_id, CURRENT_TIMESTAMP
FROM product_catalog
WHERE TRIM(canonical_product_id) <> '';

DROP INDEX IF EXISTS idx_product_catalog_owner_canonical;
ALTER TABLE product_catalog DROP COLUMN canonical_product_id;
