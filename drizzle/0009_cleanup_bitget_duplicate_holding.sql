-- Remove the one-time stale Bitget holding created under the legacy catalog ID.
-- Keep the catalog row itself: the current product response may reuse it for
-- the live 10% offer. Only the erroneous cached holding and its cache markers
-- are removed. The live 0–300 holding is stored under its own catalog ID.

DELETE FROM holdings
WHERE product_id = 'api-bg-usdt-simple-1gd23qx';

DELETE FROM holding_positions
WHERE product_id = 'api-bg-usdt-simple-1gd23qx';

UPDATE sync_snapshots
SET payload = json_set(
  json_remove(
    payload,
    '$.holdingUpdates."api-bg-usdt-simple-1gd23qx"',
    '$.holdingFallbacks."api-bg-usdt-simple-1gd23qx"'
  ),
  '$.holdingSourceIds',
  json(COALESCE((
    SELECT json_group_array(value)
    FROM json_each(json_extract(payload, '$.holdingSourceIds'))
    WHERE value <> 'api-bg-usdt-simple-1gd23qx'
  ), '[]')),
  '$.holdingPositions',
  json(COALESCE((
    SELECT json_group_array(json(value))
    FROM json_each(json_extract(payload, '$.holdingPositions'))
    WHERE json_extract(value, '$.productId') <> 'api-bg-usdt-simple-1gd23qx'
  ), '[]')))
WHERE cache_key = 'private-products'
  AND payload IS NOT NULL
  AND json_valid(payload);
