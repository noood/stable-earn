export type PlatformProductIdentityInput = {
  /** Account id already includes the platform and region (for example bybit-global). */
  accountId: string;
  asset: string;
  productType: "flexible" | "fixed";
  /** Stable upstream identity token; include a documented discriminator if the API reuses its raw product ID. */
  externalProductId: string;
};

export type ProductIdentityRecord = {
  identityKey?: string;
};

export type ProductIdentityChange = {
  state: "new" | "unchanged" | "changed";
  previousKey?: string;
  currentKey?: string;
};

/**
 * Build the identity for a user-created product.  The UUID remains the
 * durable database row id; this key describes the product itself and may
 * change when the user edits its account, asset, or kind.
 */
export function buildManualProductIdentity(input: {
  accountId: string;
  asset: string;
  productType: "flexible" | "fixed";
  slug: string;
}) {
  const accountId = input.accountId.trim();
  const asset = input.asset.trim().toUpperCase();
  const productType = input.productType.trim().toLowerCase();
  const slug = stableIdentitySlug(input.slug);
  if (!accountId || !asset || !productType || !slug) {
    throw new Error("Manual product identity requires account, asset, type, and slug");
  }
  return `${accountId}:${asset}:${productType}:manual:${slug}`;
}

export function stableIdentitySlug(value: string) {
  return value.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * Build the platform identity used by every API-backed product.
 *
 * `product_catalog.product_id` remains the durable database row id. This key
 * is the upstream identity used for matching product and holding responses.
 * When an exchange reuses its raw ID, externalProductId may be a stable
 * composite such as `rawId@duration`; no internal product-family alias is used.
 */
export function buildPlatformProductIdentity(input: PlatformProductIdentityInput) {
  const accountId = input.accountId.trim();
  const asset = input.asset.trim().toUpperCase();
  const productType = input.productType.trim().toLowerCase();
  const externalProductId = input.externalProductId.trim();
  if (!accountId || !asset || !productType || !externalProductId) {
    throw new Error("API product identity requires account, asset, type, and external product id");
  }
  const identityKey = `${accountId}:${asset}:${productType}:${externalProductId}`;
  return {
    externalProductId,
    /** @deprecated Compatibility name only; use identityKey. */
    canonicalProductId: identityKey,
    identityKey,
  };
}

/** Alias for mapping an upstream holding row without dropping its account scope. */
export function scopedExternalProductAlias(accountId: string, asset: string, externalProductId: string) {
  return `api:${accountId.trim()}:${asset.trim().toUpperCase()}:${externalProductId.trim()}`;
}

export function compareProductIdentity(previous: ProductIdentityRecord | undefined, current: ProductIdentityRecord): ProductIdentityChange {
  if (!previous) return { state: "new", currentKey: current.identityKey };
  const changed = previous.identityKey !== current.identityKey;
  return {
    state: changed ? "changed" : "unchanged",
    previousKey: previous.identityKey,
    currentKey: current.identityKey,
  };
}
