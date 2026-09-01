type IdentitySnapshot = {
  productType?: "flexible" | "fixed";
  termDays?: number;
  eligibilityRequired?: boolean;
  eligibilityLabel?: string;
  minimumAmount?: number;
  tiers?: Array<{ min: number; max: number | null }>;
};

// `identityKey` is the internal comparison value. The adapter decides whether
// a platform's raw ID is stable enough to participate in that key.

export type ProductIdentityRecord = {
  identityKey?: string;
  identityFingerprint?: string;
};

export type ProductIdentityChange = {
  state: "new" | "unchanged" | "changed";
  previousKey?: string;
  currentKey?: string;
};

export function productIdentityFingerprint(snapshot: IdentitySnapshot) {
  return JSON.stringify({
    productType: snapshot.productType ?? null,
    termDays: snapshot.termDays ?? null,
    eligibilityRequired: snapshot.eligibilityRequired ?? false,
    eligibilityLabel: snapshot.eligibilityLabel ?? null,
    minimumAmount: snapshot.minimumAmount ?? null,
    tiers: (snapshot.tiers ?? []).map(({ min, max }) => ({ min, max })),
  });
}

export function productIdentityKey(productId: string, externalProductId?: string, includeExternalProductId = false) {
  return includeExternalProductId && externalProductId
    ? `${productId}:${externalProductId}`
    : productId;
}

export function buildProductIdentity(
  productId: string,
  snapshot: IdentitySnapshot,
  options: { externalProductId?: string; includeExternalProductId?: boolean } = {},
) {
  const { externalProductId, includeExternalProductId = false } = options;
  return {
    externalProductId,
    identityKey: productIdentityKey(productId, externalProductId, includeExternalProductId),
    identityFingerprint: productIdentityFingerprint(snapshot),
  };
}

export function compareProductIdentity(previous: ProductIdentityRecord | undefined, current: ProductIdentityRecord): ProductIdentityChange {
  if (!previous) return { state: "new", currentKey: current.identityKey };
  const changed = previous.identityKey !== current.identityKey
    || previous.identityFingerprint !== current.identityFingerprint;
  return {
    state: changed ? "changed" : "unchanged",
    previousKey: previous.identityKey,
    currentKey: current.identityKey,
  };
}
