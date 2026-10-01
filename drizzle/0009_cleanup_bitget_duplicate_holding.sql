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
