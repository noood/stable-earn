import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { Product } from "./domain";
import type { LiveRate } from "./live-rates";
import { productHasComparableApr, productShouldBeActive } from "./opportunity-policy";
import { resolveProductWithoutApiData } from "./product-status";
import { catalogProductTemplates } from "./seed-data";

/**
 * The catalogue is user-scoped because authenticated APIs may expose a
 * different product set for every account. A stable identity is matched by
 * exchange/account/asset and the upstream external ID (or adapter fallback);
 * mutable APR, quota and subscription-window fields update the same row.
 * Old verified rows are retained for history and archived only when their
 * holding is explicitly known to be zero.
 */
type CatalogRow = {
  owner_id: string;
  product_id: string;
  canonical_product_id: string;
  identity_key: string;
  identity_fingerprint: string | null;
  payload: string;
  status: "active" | "archived";
  first_seen_at: string;
  last_seen_at: string;
  archived_at: string | null;
};

type HoldingRow = { product_id: string; amount: number };
type OverrideRow = { product_id: string; purchase_date: string | null };
type HoldingEvidence = { known: boolean; amount: number };

export type ProductCatalogSync = {
  products: Product[];
  rates: LiveRate[];
  /** Maps adapter ids and upstream ids to the account-scoped product id. */
  productIds: Record<string, string>;
  /** Prepared writes are committed with the cache only after an attempt wins. */
  statements: D1PreparedStatement[];
};

export async function loadCatalogRows(db: D1Database, ownerId: string) {
  const result = await db.prepare(`SELECT owner_id, product_id, canonical_product_id, identity_key,
      identity_fingerprint, payload, status, first_seen_at, last_seen_at, archived_at
      FROM product_catalog WHERE owner_id = ? ORDER BY first_seen_at, product_id`).bind(ownerId).all<CatalogRow>();
  return result.results;
}

export async function loadCatalogProducts(db: D1Database, ownerId: string) {
  const rows = await loadCatalogRows(db, ownerId);
  return rows.flatMap((row) => row.status === "active" ? parseProduct(row.payload).map(resolveProductWithoutApiData) : []);
}

export async function prepareProductCatalogSync(
  db: D1Database,
  ownerId: string,
  incomingRates: LiveRate[],
  freshHoldings: Record<string, number> = {},
  completeAccountIds: readonly string[] = [],
): Promise<ProductCatalogSync> {
  const [rows, holdingResult] = await Promise.all([
    loadCatalogRows(db, ownerId),
    db.prepare("SELECT product_id, amount FROM holdings WHERE user_id = ?").bind(ownerId).all<HoldingRow>(),
  ]);
  const overrideResult = await db.prepare("SELECT product_id, purchase_date FROM product_overrides WHERE user_id = ?").bind(ownerId).all<OverrideRow>();
  const now = new Date().toISOString();
  const completeAccounts = new Set(completeAccountIds);
  const persistedHoldings = new Map(holdingResult.results.map((row) => [row.product_id, Number(row.amount)]));
  const purchaseDates = new Map(overrideResult.results.map((row) => [row.product_id, row.purchase_date]));
  const byIdentity = new Map<string, CatalogRow[]>();
  for (const row of rows) {
    const candidates = byIdentity.get(row.identity_key) ?? [];
    candidates.push(row);
    byIdentity.set(row.identity_key, candidates);
  }
  const planned = new Map<string, { product: Product | undefined; status: "active" | "archived" }>(rows.map((row) => [row.product_id, {
    product: parseProduct(row.payload)[0],
    status: row.status,
  }]));
  const productIds: Record<string, string> = {};
  const transformedRates: LiveRate[] = [];
  const statements: D1PreparedStatement[] = [];
  const selectedByCanonical = new Map<string, Set<string>>();

  for (const rate of deduplicateRates(incomingRates).filter(rateHasKnownApr)) {
    const canonicalProductId = rate.canonicalProductId ?? rate.productId;
    const identityKey = rate.identityKey ?? canonicalProductId;
    const fingerprint = normalizeFingerprint(rate.identityFingerprint);
    const seed = catalogProductTemplates.find((product) => product.id === canonicalProductId);
    // Fingerprints are retained for diagnostics, but are not product identity.
    // Product-list and position endpoints may omit different mutable fields.
    const identityCandidates = byIdentity.get(identityKey) ?? [];
    const current = preferredCatalogRow(identityCandidates, persistedHoldings, purchaseDates)
      ?? (seed ? rows.find((row) => row.product_id === seed.id && row.identity_key === seed.identityKey) : undefined);
    const baseline = !current && seed
      ? rows.find((row) => row.product_id === seed.id && row.identity_key === seed.identityKey && !normalizeFingerprint(row.identity_fingerprint))
      : undefined;
    const selectedCurrent = current ?? baseline;
    const id = selectedCurrent?.product_id ?? catalogProductId(canonicalProductId, identityKey, fingerprint);
    const selectedBase = seed ?? (selectedCurrent ? parseProduct(selectedCurrent.payload)[0] : undefined);
    const base = restoreCachedCapacity(selectedBase, identityCandidates) ?? productTemplateFromRate(rate, id, identityKey);
    if (!base) continue;

    const product = productFromRate(base, rate, id, identityKey);
    const evidence = holdingEvidence(product, rate, id, freshHoldings, persistedHoldings, completeAccounts);
    const active = productShouldBeActive(product, evidence, selectedCurrent?.status === "active");
    mapProductIds(productIds, rate, canonicalProductId, identityKey, id);

    const selected = selectedByCanonical.get(canonicalProductId) ?? new Set<string>();
    selected.add(id);
    selectedByCanonical.set(canonicalProductId, selected);

    if (selectedCurrent) {
      planned.set(id, { product, status: active ? "active" : "archived" });
      statements.push(updateCatalogStatement(db, ownerId, selectedCurrent, product, canonicalProductId, active, now));
    } else if (active) {
      planned.set(id, { product, status: "active" });
      statements.push(insertCatalogStatement(db, ownerId, product, canonicalProductId, identityKey, now));
    }
    if (active) transformedRates.push({ ...rate, productId: id, canonicalProductId });
  }

  // A product omitted from the latest list is not a new identity. Existing
  // rows are archived only when a complete holding snapshot proves they are
  // empty and another row now represents the same stable identity.
  for (const [canonicalProductId, selectedIds] of selectedByCanonical) {
    for (const row of rows.filter((candidate) => candidate.status === "active"
      && candidate.canonical_product_id === canonicalProductId
      && !selectedIds.has(candidate.product_id))) {
      const product = parseProduct(row.payload)[0];
      if (!product) continue;
      const selectedForIdentity = selectedIds.has(row.product_id)
        ? row
        : preferredCatalogRow(byIdentity.get(row.identity_key) ?? [], persistedHoldings, purchaseDates);
      // Once a stable identity has a selected active row, duplicate active
      // rows created by an older fingerprint must not remain visible.
      if (selectedForIdentity && selectedForIdentity.product_id !== row.product_id
        && selectedForIdentity.status === "active"
        && (persistedHoldings.get(row.product_id) ?? 0) <= 0) {
        planned.set(row.product_id, { product, status: "archived" });
        statements.push(archiveCatalogStatement(db, ownerId, row.product_id, now));
        continue;
      }
      const evidence = existingHoldingEvidence(product, row, freshHoldings, persistedHoldings, completeAccounts);
      if (!evidence.known || evidence.amount > 0) continue;
      planned.set(row.product_id, { product, status: "archived" });
      statements.push(archiveCatalogStatement(db, ownerId, row.product_id, now));
    }
  }

  // Some account APIs return holdings without product-rate rows. A positive
  // holding can activate a manual-information shell; an API-information
  // template still cannot enter without a verified APR.
  for (const [sourceId, rawAmount] of Object.entries(freshHoldings)) {
    if (productIds[sourceId]) continue;
    const amount = Number(rawAmount);
    const current = resolveExistingRow(rows, sourceId);
    const seed = catalogProductTemplates.find((product) => product.id === sourceId);
    const base = current ? parseProduct(current.payload)[0] : seed;
    if (!base || !Number.isFinite(amount)
      || (base.productDataMode === "api" && (base.source.kind !== "live" || !productHasComparableApr(base)))) continue;
    // A zero balance alone must not turn a normalization template into a
    // user-visible manual product. Positive holdings still need a row so the
    // user can complete product fields that the account API does not expose.
    if (base.productDataMode === "manual" && amount <= 0) continue;
    const id = current?.product_id ?? base.id;
    const product = { ...base, id };
    const active = productShouldBeActive(product, { known: true, amount }, current?.status === "active");
    productIds[sourceId] = id;
    productIds[product.identityKey] = id;
    if (product.externalProductId) productIds[product.externalProductId] = id;
    if (current) {
      if (current.status !== (active ? "active" : "archived")) {
        planned.set(id, { product, status: active ? "active" : "archived" });
        statements.push(active
          ? reactivateCatalogStatement(db, ownerId, id, now)
          : archiveCatalogStatement(db, ownerId, id, now));
      }
    } else if (active) {
      planned.set(id, { product, status: "active" });
      statements.push(insertCatalogStatement(db, ownerId, product, base.id, product.identityKey, now));
    }
  }

  const products = [...planned.values()]
    .flatMap((entry) => entry.status === "active" && entry.product ? [resolveProductWithoutApiData(entry.product)] : [])
    .sort((left, right) => left.id.localeCompare(right.id));
  return { products, rates: transformedRates, productIds, statements };
}

export async function resolveCatalogProductIds(db: D1Database, ownerId: string) {
  const [rows, holdingResult, overrideResult] = await Promise.all([
    loadCatalogRows(db, ownerId),
    db.prepare("SELECT product_id, amount FROM holdings WHERE user_id = ?").bind(ownerId).all<HoldingRow>(),
    db.prepare("SELECT product_id, purchase_date FROM product_overrides WHERE user_id = ?").bind(ownerId).all<OverrideRow>(),
  ]);
  const persistedHoldings = new Map(holdingResult.results.map((row) => [row.product_id, Number(row.amount)]));
  const purchaseDates = new Map(overrideResult.results.map((row) => [row.product_id, row.purchase_date]));
  const byIdentity = new Map<string, CatalogRow[]>();
  for (const row of rows) {
    const candidates = byIdentity.get(row.identity_key) ?? [];
    candidates.push(row);
    byIdentity.set(row.identity_key, candidates);
  }
  const map: Record<string, string> = {};
  for (const candidates of byIdentity.values()) {
    const preferred = preferredCatalogRow(candidates, persistedHoldings, purchaseDates);
    if (!preferred) continue;
    for (const row of candidates) {
      if (row.status === "active") map[row.product_id] = preferred.product_id;
    }
    map[preferred.canonical_product_id] = preferred.product_id;
    map[preferred.identity_key] = preferred.product_id;
    const product = parseProduct(preferred.payload)[0];
    if (product?.externalProductId) map[product.externalProductId] = preferred.product_id;
  }
  return map;
}

/**
 * Removing an account key should stop showing API-only products that have no
 * recorded holding. The catalog row remains archived for history and can be
 * reactivated if the account is configured again and the product is found.
 */
export async function archiveUnheldAuthenticatedCatalogProducts(
  db: D1Database,
  ownerId: string,
  accountId: string,
) {
  const archivedAt = new Date().toISOString();
  await db.prepare(`UPDATE product_catalog
      SET status = 'archived', archived_at = ?, last_seen_at = ?
      WHERE owner_id = ?
        AND status = 'active'
        AND json_valid(payload)
        AND json_extract(payload, '$.accountId') = ?
        AND json_extract(payload, '$.productDataMode') = 'api'
        AND json_extract(payload, '$.apiAccess') = 'authenticated'
        AND COALESCE((
          SELECT amount FROM holdings
          WHERE holdings.user_id = product_catalog.owner_id
            AND holdings.product_id = product_catalog.product_id
        ), 0) <= 0`)
    .bind(archivedAt, archivedAt, ownerId, accountId)
    .run();
}

function holdingEvidence(
  product: Product,
  rate: LiveRate,
  id: string,
  fresh: Record<string, number>,
  persisted: Map<string, number>,
  completeAccounts: Set<string>,
): HoldingEvidence {
  const freshValue = firstHolding(fresh, [id, rate.productId, rate.externalProductId, rate.identityKey]);
  if (freshValue !== undefined) return { known: true, amount: freshValue };
  if (completeAccounts.has(product.accountId)) return { known: true, amount: 0 };
  const persistedValue = persisted.get(id);
  if (persistedValue !== undefined) return { known: true, amount: persistedValue };
  return product.holdingDataMode === "manual" ? { known: true, amount: 0 } : { known: false, amount: 0 };
}

function existingHoldingEvidence(
  product: Product,
  row: CatalogRow,
  fresh: Record<string, number>,
  persisted: Map<string, number>,
  completeAccounts: Set<string>,
): HoldingEvidence {
  const freshValue = firstHolding(fresh, [row.product_id, row.identity_key, product.externalProductId]);
  if (freshValue !== undefined) return { known: true, amount: freshValue };
  if (completeAccounts.has(product.accountId)) return { known: true, amount: 0 };
  const persistedValue = persisted.get(row.product_id);
  if (persistedValue !== undefined) return { known: true, amount: persistedValue };
  return product.holdingDataMode === "manual" ? { known: true, amount: 0 } : { known: false, amount: 0 };
}

function firstHolding(values: Record<string, number>, ids: Array<string | undefined>) {
  for (const id of ids) {
    if (!id || !Object.prototype.hasOwnProperty.call(values, id)) continue;
    const amount = Number(values[id]);
    if (Number.isFinite(amount)) return amount;
  }
  return undefined;
}

function preferredCatalogRow(
  rows: CatalogRow[],
  persistedHoldings: Map<string, number>,
  purchaseDates: Map<string, string | null>,
) {
  return [...rows].sort((left, right) => {
    const leftActive = left.status === "active" ? 1 : 0;
    const rightActive = right.status === "active" ? 1 : 0;
    if (leftActive !== rightActive) return rightActive - leftActive;
    const leftHolding = (persistedHoldings.get(left.product_id) ?? 0) > 0 ? 1 : 0;
    const rightHolding = (persistedHoldings.get(right.product_id) ?? 0) > 0 ? 1 : 0;
    if (leftHolding !== rightHolding) return rightHolding - leftHolding;
    const leftPurchased = purchaseDates.get(left.product_id) ? 1 : 0;
    const rightPurchased = purchaseDates.get(right.product_id) ? 1 : 0;
    if (leftPurchased !== rightPurchased) return rightPurchased - leftPurchased;
    return left.first_seen_at.localeCompare(right.first_seen_at) || left.product_id.localeCompare(right.product_id);
  })[0];
}

/**
 * A one-time identity merge may keep the row carrying the user's holding,
 * while an archived duplicate still has the last known quota. Reuse that
 * finite quota as cache data instead of exposing a false "limit pending" state.
 */
function restoreCachedCapacity(base: Product | undefined, candidates: CatalogRow[]) {
  if (!base) return undefined;
  const currentMax = base.tiers[0]?.max;
  if (currentMax !== null && currentMax !== undefined && Number.isFinite(currentMax)) return base;
  const cached = candidates
    .map((row) => parseProduct(row.payload)[0])
    .filter((product): product is Product => Boolean(product))
    .map((product) => ({ product, max: product.tiers[0]?.max }))
    .filter(({ max }) => max !== null && max !== undefined && Number.isFinite(max) && max > 0)
    .sort((left, right) => Number(right.max) - Number(left.max))[0];
  if (!cached) return base;
  return {
    ...base,
    tiers: base.tiers.map((tier, index) => index === 0 && tier.max === null
      ? { ...tier, max: cached.max! }
      : tier),
    rateCoverage: base.rateCoverage === "base_only" ? "complete" : base.rateCoverage,
    capacitySource: "cache" as const,
    capacityFetchedAt: cached.product.capacityFetchedAt ?? cached.product.source.fetchedAt,
  };
}

function resolveExistingRow(rows: CatalogRow[], sourceId: string) {
  return rows.find((row) => row.product_id === sourceId)
    ?? rows.find((row) => row.identity_key === sourceId)
    ?? rows.find((row) => parseProduct(row.payload)[0]?.externalProductId === sourceId)
    ?? rows.find((row) => row.canonical_product_id === sourceId);
}

function mapProductIds(map: Record<string, string>, rate: LiveRate, canonical: string, identity: string, id: string) {
  for (const key of [id, rate.productId, canonical, identity, rate.externalProductId]) {
    if (key) map[key] = id;
  }
}

function deduplicateRates(rates: LiveRate[]) {
  const byIdentity = new Map<string, LiveRate>();
  for (const rate of rates) {
    const canonical = rate.canonicalProductId ?? rate.productId;
    const identity = rate.identityKey ?? canonical;
    const previous = byIdentity.get(identity);
    // Prefer the richer product-list response over a position-only fallback.
    // Both responses describe the same stable product identity.
    if (!previous || liveRateScore(rate) > liveRateScore(previous)) byIdentity.set(identity, rate);
  }
  return [...byIdentity.values()];
}

function liveRateScore(rate: LiveRate) {
  return Number(Boolean(rate.tiers?.some((tier) => tier.max !== null)))
    + Number(Boolean(rate.minimumAmount !== undefined))
    + Number(rate.rateCoverage === "complete")
    + Number(Boolean(rate.subscriptionStartsAt || rate.subscriptionEndsAt));
}

function rateHasKnownApr(rate: LiveRate) {
  return rate.rateCoverage !== "unavailable" && Number.isFinite(rate.apr);
}

function updateCatalogStatement(
  db: D1Database,
  ownerId: string,
  row: CatalogRow,
  product: Product,
  canonicalProductId: string,
  active: boolean,
  now: string,
) {
  return db.prepare(`UPDATE product_catalog SET
      canonical_product_id = ?, identity_key = ?, identity_fingerprint = ?, payload = ?,
      status = ?, last_seen_at = ?, archived_at = ?
      WHERE owner_id = ? AND product_id = ?`)
    .bind(canonicalProductId, product.identityKey, normalizeFingerprint(product.identityFingerprint), JSON.stringify(product),
      active ? "active" : "archived", now, active ? null : now, ownerId, row.product_id);
}

function insertCatalogStatement(
  db: D1Database,
  ownerId: string,
  product: Product,
  canonicalProductId: string,
  identityKey: string,
  now: string,
) {
  return db.prepare(`INSERT INTO product_catalog
      (owner_id, product_id, canonical_product_id, identity_key, identity_fingerprint, payload, status, first_seen_at, last_seen_at, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
      ON CONFLICT(owner_id, product_id) DO UPDATE SET
        canonical_product_id = excluded.canonical_product_id,
        identity_key = excluded.identity_key,
        identity_fingerprint = excluded.identity_fingerprint,
        payload = excluded.payload,
        last_seen_at = excluded.last_seen_at,
        status = 'active',
        archived_at = NULL`)
    .bind(ownerId, product.id, canonicalProductId, identityKey, normalizeFingerprint(product.identityFingerprint), JSON.stringify(product), now, now);
}

function archiveCatalogStatement(db: D1Database, ownerId: string, productId: string, now: string) {
  return db.prepare(`UPDATE product_catalog SET status = 'archived', archived_at = ?, last_seen_at = ?
      WHERE owner_id = ? AND product_id = ?`).bind(now, now, ownerId, productId);
}

function reactivateCatalogStatement(db: D1Database, ownerId: string, productId: string, now: string) {
  return db.prepare(`UPDATE product_catalog SET status = 'active', archived_at = NULL, last_seen_at = ?
      WHERE owner_id = ? AND product_id = ?`).bind(now, ownerId, productId);
}

function productFromRate(base: Product, rate: LiveRate, id: string, identityKey: string): Product {
  const tiers = rate.tiers
    ? rate.tiers.map((tier, index) => {
      const previous = base.tiers[index];
      const preserveKnownCapacity = rate.capacitySource === "cache"
        && tier.max === null
        && previous?.max !== null
        && previous?.max !== undefined;
      return { ...tier, max: preserveKnownCapacity ? previous.max : tier.max, id: `${id}-tier-${index}` };
    })
    : base.tiers.map((tier, index) => rate.tierAprs?.[index] !== undefined
      ? { ...tier, id: `${id}-tier-${index}`, apr: rate.tierAprs[index] }
      : index === 0 ? { ...tier, id: `${id}-tier-${index}`, apr: rate.apr } : { ...tier, id: `${id}-tier-${index}` });
  const capacityKnown = tiers[0]?.max !== null && tiers[0]?.max !== undefined;
  const capacitySource = rate.capacitySource === "cache"
    ? capacityKnown ? "cache" : undefined
    : rate.capacitySource === "live"
      ? "live"
      : capacityKnown ? base.capacitySource : undefined;
  return {
    ...base,
    id,
    name: rate.name ?? base.name,
    productType: rate.productType ?? base.productType,
    termDays: rate.termDays ?? base.termDays,
    minimumAmount: rate.minimumAmount ?? base.minimumAmount,
    subscriptionStartsAt: rate.subscriptionStartsAt ?? base.subscriptionStartsAt,
    subscriptionEndsAt: rate.subscriptionEndsAt ?? base.subscriptionEndsAt,
    availability: rate.availability ?? base.availability,
    eligibilityRequired: rate.eligibilityRequired ?? base.eligibilityRequired,
    eligibilityLabel: rate.eligibilityLabel ?? base.eligibilityLabel,
    eligibilityStatus: rate.eligibilityStatus ?? base.eligibilityStatus,
    externalProductId: rate.externalProductId ?? base.externalProductId,
    identityKey,
    identityFingerprint: rate.identityFingerprint ?? base.identityFingerprint,
    tiers,
    rateCoverage: rate.rateCoverage === "base_only" && capacityKnown
      ? "complete"
      : rate.rateCoverage ?? (rate.tiers ? "complete" : base.rateCoverage),
    // A cache source is truthful only when the cached tier actually supplied
    // a finite limit. If both the live response and cache lack the limit,
    // keep the product as base_only without claiming that a quota was cached.
    capacitySource,
    capacityFetchedAt: capacitySource === "cache" ? base.capacityFetchedAt ?? base.source.fetchedAt : rate.capacityFetchedAt,
    source: { kind: "live", label: rate.sourceLabel, fetchedAt: rate.fetchedAt },
  };
}

function productTemplateFromRate(rate: LiveRate, id: string, identityKey: string): Product | undefined {
  const catalog = rate.catalog;
  if (!catalog) return undefined;
  const tiers = rate.tiers?.map((tier, index) => ({ ...tier, id: `${id}-tier-${index}` }))
    ?? [{ id: `${id}-tier-0`, min: 0, max: null, apr: rate.apr }];
  return {
    id,
    accountId: catalog.accountId,
    exchange: catalog.exchange,
    region: catalog.region,
    asset: catalog.asset,
    name: rate.name ?? "API 产品",
    productDataMode: "api",
    apiAccess: catalog.apiAccess,
    holdingDataMode: catalog.holdingDataMode,
    productType: rate.productType ?? "flexible",
    termDays: rate.termDays,
    minimumAmount: rate.minimumAmount,
    subscriptionStartsAt: rate.subscriptionStartsAt,
    subscriptionEndsAt: rate.subscriptionEndsAt,
    availability: rate.availability,
    eligibilityRequired: rate.eligibilityRequired,
    eligibilityLabel: rate.eligibilityLabel,
    eligibilityStatus: rate.eligibilityStatus,
    tiers,
    source: { kind: "live", label: rate.sourceLabel, fetchedAt: rate.fetchedAt },
    rateCoverage: rate.rateCoverage ?? (rate.tiers ? "complete" : "base_only"),
    capacitySource: rate.capacitySource ?? (rate.tiers?.some((tier) => tier.max !== null) ? "live" : undefined),
    capacityFetchedAt: rate.capacityFetchedAt,
    externalProductId: rate.externalProductId,
    identityKey,
    identityFingerprint: rate.identityFingerprint,
  };
}

function parseProduct(payload: string) {
  try {
    const value = JSON.parse(payload) as Product;
    return value && typeof value.id === "string" && typeof value.identityKey === "string" ? [value] : [];
  } catch {
    return [];
  }
}

function catalogProductId(canonicalProductId: string, identityKey: string, fingerprint: string | null) {
  const value = `${canonicalProductId}|${identityKey}|${fingerprint ?? ""}`;
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const slug = canonicalProductId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 40);
  return `api-${slug}-${(hash >>> 0).toString(36)}`;
}

function normalizeFingerprint(value: string | null | undefined) {
  return value?.trim() || null;
}
