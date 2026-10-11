-- Store a user's category only when a complete product record has no type.
ALTER TABLE product_overrides ADD COLUMN product_kind_override TEXT
  CHECK (product_kind_override IS NULL OR product_kind_override IN ('flexible', 'fixed', 'limited'));
