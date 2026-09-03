import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import type { Product } from "./domain";
import type { LiveRate } from "./live-rates";
import { productShouldBeActive } from "./opportunity-policy";
import { productIdentityFingerprint } from "./product-identity";
import { resolveProductWithoutApiData } from "./product-status";
import { defaultCatalogSeedProducts } from "./seed-data";

const retiredDefaultProductIds = new Set(["by-eu-usdc"]);

/**
 * The catalogue is user-scoped because authenticated APIs may expose a
 * different product set for every account. Identity changes create a new row;
 * old rows are retained for history and are archived only when their holding
 * is explicitly known to be zero.
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
  const now = new Date().toISOString();
  const completeAccounts = new Set(completeAccountIds);
  const persistedHoldings = new Map(holdingResult.results.map((row) => [row.product_id, Number(row.amount)]));
  const byIdentity = new Map(rows.map((row) => [identityLookupKey(row.identity_key, row.identity_fingerprint), row]));
  const planned = new Map<string, { product: Product | undefined; status: "active" | "archived" }>(rows.map((row) => [row.product_id, {
    product: parseProduct(row.payload)[0],
    status: row.status,
  }]));
  const productIds: Record<string, string> = {};
  const transformedRates: LiveRate[] = [];
  const statements: D1PreparedStatement[] = [];
  const selectedByCanonical = new Map<string, Set<string>>();

  for (const rate of deduplicateRates(incomingRates)) {
    const canonicalProductId = rate.canonicalProductId ?? rate.productId;
    const identityKey = rate.identityKey ?? canonicalProductId;
    const fingerprint = normalizeFingerprint(rate.identityFingerprint);
    const seed = defaultCatalogSeedProducts.find((product) => product.id === canonicalProductId);
    const exact = byIdentity.get(identityLookupKey(identityKey, fingerprint));
    const compatible = !exact ? rows.find((row) => {
      if (row.identity_key !== identityKey) return false;
      const product = parseProduct(row.payload)[0];
      return product && productIdentityFingerprint(product) === fingerprint;
    }) : undefined;
    const baseline = !exact && !compatible && seed
      ? rows.find((row) => row.product_id === seed.id && row.identity_key === seed.identityKey && !normalizeFingerprint(row.identity_fingerprint))
      : undefined;
    const current = exact ?? compatible ?? baseline;
    const id = current?.product_id ?? catalogProductId(canonicalProductId, identityKey, fingerprint);
    const base = seed ?? (current ? parseProduct(current.payload)[0] : undefined) ?? productTemplateFromRate(rate, id, identityKey);
    if (!base) continue;

    const product = productFromRate(base, rate, id, identityKey);
    const evidence = holdingEvidence(product, rate, id, freshHoldings, persistedHoldings, completeAccounts);
    const active = productShouldBeActive(product, evidence, current?.status === "active");
    mapProductIds(productIds, rate, canonicalProductId, identityKey, id);

    const selected = selectedByCanonical.get(canonicalProductId) ?? new Set<string>();
    selected.add(id);
    selectedByCanonical.set(canonicalProductId, selected);

    if (current) {
      planned.set(id, { product, status: active ? "active" : "archived" });
      statements.push(updateCatalogStatement(db, ownerId, current, product, canonicalProductId, active, now));
    } else if (active) {
      planned.set(id, { product, status: "active" });
      statements.push(insertCatalogStatement(db, ownerId, product, canonicalProductId, identityKey, now));
    }
    if (active) transformedRates.push({ ...rate, productId: id, canonicalProductId });
  }

  // A new subscription window is a new identity. The previous cycle is only
  // archived when a complete holding snapshot proves that it is empty.
  for (const [canonicalProductId, selectedIds] of selectedByCanonical) {
    for (const row of rows.filter((candidate) => candidate.status === "active"
      && candidate.canonical_product_id === canonicalProductId
      && !selectedIds.has(candidate.product_id))) {
      const product = parseProduct(row.payload)[0];
      if (!product) continue;
      const evidence = existingHoldingEvidence(product, row, freshHoldings, persistedHoldings, completeAccounts);
      if (!evidence.known || evidence.amount > 0) continue;
      planned.set(row.product_id, { product, status: "archived" });
      statements.push(archiveCatalogStatement(db, ownerId, row.product_id, now));
    }
  }

  // Some account APIs return holdings without product-rate rows. Positive
  // holdings still activate the matching catalogue/seed product.
  for (const [sourceId, rawAmount] of Object.entries(freshHoldings)) {
    if (productIds[sourceId]) continue;
    const amount = Number(rawAmount);
    const current = resolveExistingRow(rows, sourceId);
    const seed = defaultCatalogSeedProducts.find((product) => product.id === sourceId);
    const base = current ? parseProduct(current.payload)[0] : seed;
    if (!base || !Number.isFinite(amount)) continue;
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

  // Retire legacy default placeholders that are no longer part of the
  // catalogue. Keep a positive holding visible, but allow a future API rate
  // (with a real product payload) to create/reactivate the product normally.
  for (const row of rows.filter((candidate) => candidate.status === "active" && retiredDefaultProductIds.has(candidate.product_id))) {
    if (selectedByCanonical.has(row.canonical_product_id) || selectedByCanonical.has(row.product_id)) continue;
    const product = parseProduct(row.payload)[0];
    const evidence = product
      ? existingHoldingEvidence(product, row, freshHoldings, persistedHoldings, completeAccounts)
      : { known: false, amount: 0 };
    if (evidence.known && evidence.amount > 0) continue;
    if (product) planned.set(row.product_id, { product, status: "archived" });
    statements.push(archiveCatalogStatement(db, ownerId, row.product_id, now));
  }
  // A previous delete should not block a later real API product with the same
  // identifier. Only clear the marker when there is no positive holding to
  // preserve the user's explicit hide choice for an owned product.
  for (const productId of retiredDefaultProductIds) {
    const freshAmount = firstHolding(freshHoldings, [productId]);
    const persistedAmount = persistedHoldings.get(productId);
    if ((freshAmount !== undefined && freshAmount > 0) || (persistedAmount !== undefined && persistedAmount > 0)) continue;
    statements.push(db.prepare("DELETE FROM hidden_products WHERE user_id = ? AND product_id = ?").bind(ownerId, productId));
    statements.push(db.prepare("DELETE FROM hidden_seed_products WHERE user_id = ? AND product_id = ?").bind(ownerId, productId));
  }

  const products = [...planned.values()]
    .flatMap((entry) => entry.status === "active" && entry.product ? [resolveProductWithoutApiData(entry.product)] : [])
    .sort((left, right) => left.id.localeCompare(right.id));
  return { products, rates: transformedRates, productIds, statements };
}

export async function resolveCatalogProductIds(db: D1Database, ownerId: string) {
  const rows = await loadCatalogRows(db, ownerId);
  const map: Record<string, string> = {};
  for (const row of rows) {
    if (row.status !== "active") continue;
    map[row.product_id] = row.product_id;
    map[row.canonical_product_id] = row.product_id;
    map[row.identity_key] = row.product_id;
    const product = parseProduct(row.payload)[0];
    if (product?.externalProductId) map[product.externalProductId] = row.product_id;
  }
  return map;
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
  return persistedValue === undefined ? { known: false, amount: 0 } : { known: true, amount: persistedValue };
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
  return persistedValue === undefined ? { known: false, amount: 0 } : { known: true, amount: persistedValue };
}

function firstHolding(values: Record<string, number>, ids: Array<string | undefined>) {
  for (const id of ids) {
    if (!id || !Object.prototype.hasOwnProperty.call(values, id)) continue;
    const amount = Number(values[id]);
    if (Number.isFinite(amount)) return amount;
  }
  return undefined;
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
    byIdentity.set(identityLookupKey(identity, normalizeFingerprint(rate.identityFingerprint)), rate);
  }
  return [...byIdentity.values()];
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
    ? rate.tiers.map((tier, index) => ({ ...tier, id: `${id}-tier-${index}` }))
    : base.tiers.map((tier, index) => rate.tierAprs?.[index] !== undefined
      ? { ...tier, id: `${id}-tier-${index}`, apr: rate.tierAprs[index] }
      : index === 0 ? { ...tier, id: `${id}-tier-${index}`, apr: rate.apr } : { ...tier, id: `${id}-tier-${index}` });
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
    rateCoverage: rate.rateCoverage ?? (rate.tiers ? "complete" : base.rateCoverage),
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

function identityLookupKey(identityKey: string, fingerprint: string | null) {
  return `${identityKey}\u0000${normalizeFingerprint(fingerprint) ?? ""}`;
}
