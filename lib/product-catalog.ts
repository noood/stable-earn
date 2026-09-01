import type { D1Database } from "@cloudflare/workers-types";
import type { Product } from "./domain";
import type { LiveRate } from "./live-rates";
import { seedProducts } from "./seed-data";
import { resolveProductWithoutApiData } from "./product-status";

/**
 * The catalogue is user-scoped because an authenticated API can expose a
 * different product/eligibility set for each account.  A row is an immutable
 * product identity in practice: when the upstream identity changes, the old
 * row is archived and a new internal id is created.
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

export type ProductCatalogSync = {
  products: Product[];
  rates: LiveRate[];
  /** Maps adapter slot ids (and legacy holding ids) to the current row id. */
  productIds: Record<string, string>;
};

export async function ensureSeedProductCatalog(db: D1Database, ownerId: string) {
  const now = new Date().toISOString();
  await db.batch(seedProducts.map((product) => db.prepare(`INSERT INTO product_catalog
      (owner_id, product_id, canonical_product_id, identity_key, identity_fingerprint, payload, status, first_seen_at, last_seen_at, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
      ON CONFLICT(owner_id, product_id) DO NOTHING`)
    .bind(ownerId, product.id, product.id, product.identityKey, product.identityFingerprint ?? null, JSON.stringify(product), now, now)));
}

export async function loadCatalogRows(db: D1Database, ownerId: string) {
  await ensureSeedProductCatalog(db, ownerId);
  const result = await db.prepare(`SELECT owner_id, product_id, canonical_product_id, identity_key,
      identity_fingerprint, payload, status, first_seen_at, last_seen_at, archived_at
      FROM product_catalog WHERE owner_id = ? ORDER BY first_seen_at, product_id`).bind(ownerId).all<CatalogRow>();
  return result.results;
}

export async function loadCatalogProducts(db: D1Database, ownerId: string) {
  const rows = await loadCatalogRows(db, ownerId);
  return rows.flatMap((row) => row.status === "active" ? parseProduct(row.payload).map(resolveProductWithoutApiData) : []);
}

export async function syncProductCatalog(db: D1Database, ownerId: string, incomingRates: LiveRate[]): Promise<ProductCatalogSync> {
  const rows = await loadCatalogRows(db, ownerId);
  const byIdentity = new Map(rows.map((row) => [identityLookupKey(row.identity_key, row.identity_fingerprint), row]));
  const activeRows = rows.filter((row) => row.status === "active");
  const now = new Date().toISOString();
  const productIds: Record<string, string> = {};
  const transformedRates: LiveRate[] = [];
  const changedRows: Array<{ row: CatalogRow; product: Product; rate: LiveRate }> = [];
  const newRows: Array<{ product: Product; rate: LiveRate; id: string; identityKey: string }> = [];

  for (const rate of incomingRates) {
    const identityKey = rate.identityKey ?? rate.productId;
    const fingerprint = rate.identityFingerprint ?? null;
    const seed = seedProducts.find((product) => product.id === rate.productId);
    const exact = byIdentity.get(identityLookupKey(identityKey, fingerprint));
    const exactMatches = exact && exact.identity_fingerprint === fingerprint;
    const baseline = !exact && seed
      ? rows.find((row) => row.product_id === seed.id && row.identity_key === seed.identityKey && !row.identity_fingerprint)
      : undefined;
    const current = exactMatches ? exact : baseline;
    const id = current?.product_id ?? catalogProductId(rate.productId, identityKey, fingerprint);
    const base = seed ?? (current ? parseProduct(current.payload)[0] : undefined);
    if (!base) continue;
    const product = productFromRate(base, rate, id, identityKey);
    if (current) changedRows.push({ row: current, product, rate });
    else newRows.push({ product, rate, id, identityKey });
    productIds[rate.productId] = id;
    productIds[identityKey] = id;
    transformedRates.push({ ...rate, productId: id, canonicalProductId: rate.productId });
  }

  const statements = [
    ...changedRows.map(({ row, product, rate }) => db.prepare(`UPDATE product_catalog SET
        canonical_product_id = ?, identity_key = ?, identity_fingerprint = ?, payload = ?,
        status = 'active', last_seen_at = ?, archived_at = NULL
        WHERE owner_id = ? AND product_id = ?`)
      .bind(rate.productId, product.identityKey, product.identityFingerprint ?? "", JSON.stringify(product), now, ownerId, row.product_id)),
    ...newRows.map(({ product, rate, id, identityKey }) => db.prepare(`INSERT INTO product_catalog
        (owner_id, product_id, canonical_product_id, identity_key, identity_fingerprint, payload, status, first_seen_at, last_seen_at, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
        ON CONFLICT(owner_id, product_id) DO UPDATE SET
          payload = excluded.payload, last_seen_at = excluded.last_seen_at, status = 'active', archived_at = NULL`)
      .bind(ownerId, id, rate.productId, identityKey, product.identityFingerprint ?? "", JSON.stringify(product), now, now)),
  ];

  // A changed identity is a new product, not an overwrite.  Keep the old row
  // available for historical holdings, but stop showing it in the active list.
  const selectedByCanonical = new Map<string, Set<string>>();
  for (const rate of incomingRates) {
    const selectedId = productIds[rate.identityKey ?? rate.productId];
    if (!selectedId) continue;
    const selected = selectedByCanonical.get(rate.productId) ?? new Set<string>();
    selected.add(selectedId);
    selectedByCanonical.set(rate.productId, selected);
  }
  for (const [canonicalProductId, selectedIds] of selectedByCanonical) {
    for (const row of activeRows.filter((candidate) => candidate.canonical_product_id === canonicalProductId && !selectedIds.has(candidate.product_id))) {
      statements.push(db.prepare(`UPDATE product_catalog SET status = 'archived', archived_at = ?, last_seen_at = ?
        WHERE owner_id = ? AND product_id = ?`).bind(now, now, ownerId, row.product_id));
    }
  }
  if (statements.length > 0) await db.batch(statements);

  const latestRows = await loadCatalogRows(db, ownerId);
  const products = latestRows.flatMap((row) => row.status === "active" ? parseProduct(row.payload).map(resolveProductWithoutApiData) : []);
  return { products, rates: transformedRates, productIds };
}

export async function resolveCatalogProductIds(db: D1Database, ownerId: string) {
  const rows = await loadCatalogRows(db, ownerId);
  const map: Record<string, string> = {};
  for (const row of rows) {
    if (row.status === "active") map[row.canonical_product_id] = row.product_id;
  }
  return map;
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
    subscriptionEndsAt: rate.subscriptionEndsAt ?? base.subscriptionEndsAt,
    eligibilityRequired: rate.eligibilityRequired ?? base.eligibilityRequired,
    eligibilityLabel: rate.eligibilityLabel ?? base.eligibilityLabel,
    externalProductId: rate.externalProductId ?? base.externalProductId,
    identityKey,
    identityFingerprint: rate.identityFingerprint ?? base.identityFingerprint,
    tiers,
    rateCoverage: rate.rateCoverage ?? (rate.tiers ? "complete" : base.rateCoverage),
    source: { kind: "live", label: rate.sourceLabel, fetchedAt: rate.fetchedAt },
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

function identityLookupKey(identityKey: string, fingerprint: string | null) {
  return `${identityKey}\u0000${fingerprint ?? ""}`;
}
