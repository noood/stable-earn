import type { D1Database } from "@cloudflare/workers-types";

type CatalogAuditRow = {
  owner_id: string;
  product_id: string;
  canonical_product_id: string;
  identity_key: string;
  identity_fingerprint: string | null;
  status: "active" | "archived";
  payload: string;
};

type ProductReferenceRow = {
  owner_id: string;
  product_id: string;
};

type SnapshotRow = {
  owner_id: string;
  payload: string | null;
};

export type CatalogIdentityAudit = {
  rows: CatalogAuditRow[];
  duplicateIdentityGroups: CatalogAuditRow[][];
  activeCanonicalGroups: CatalogAuditRow[][];
  generatedProductIds: CatalogAuditRow[];
  orphanReferences: Array<{ source: string; ownerId: string; productId: string }>;
  summary: {
    owners: number;
    catalogRows: number;
    activeRows: number;
    duplicateIdentityGroups: number;
    activeCanonicalGroups: number;
    generatedProductIds: number;
    orphanReferences: number;
    needsMigrationReview: boolean;
  };
};

/**
 * Read-only audit of persisted product identities and all user-data references.
 * It intentionally does not choose winners or prepare writes: duplicate
 * canonical families can be legitimate (for example fixed-term offers), so a
 * migration decision must be made from the returned rows and holdings.
 */
export async function auditCatalogIdentities(db: D1Database, ownerId?: string): Promise<CatalogIdentityAudit> {
  const scope = ownerId ? " WHERE owner_id = ?" : "";
  const args = ownerId ? [ownerId] : [];
  const [catalogResult, holdingResult, positionResult, overrideResult, hiddenResult, hiddenSeedResult, snapshotResult] = await Promise.all([
    db.prepare(`SELECT owner_id, product_id, canonical_product_id, identity_key,
        identity_fingerprint, status, payload
        FROM product_catalog${scope} ORDER BY owner_id, identity_key, product_id`).bind(...args).all<CatalogAuditRow>(),
    db.prepare(`SELECT user_id AS owner_id, product_id FROM holdings${ownerId ? " WHERE user_id = ?" : ""}`).bind(...args).all<ProductReferenceRow>(),
    db.prepare(`SELECT user_id AS owner_id, product_id FROM holding_positions${ownerId ? " WHERE user_id = ?" : ""}`).bind(...args).all<ProductReferenceRow>(),
    db.prepare(`SELECT user_id AS owner_id, product_id FROM product_overrides${ownerId ? " WHERE user_id = ?" : ""}`).bind(...args).all<ProductReferenceRow>(),
    db.prepare(`SELECT user_id AS owner_id, product_id FROM hidden_products${ownerId ? " WHERE user_id = ?" : ""}`).bind(...args).all<ProductReferenceRow>(),
    db.prepare(`SELECT user_id AS owner_id, product_id FROM hidden_seed_products${ownerId ? " WHERE user_id = ?" : ""}`).bind(...args).all<ProductReferenceRow>(),
    db.prepare(`SELECT owner_id, payload FROM sync_snapshots WHERE cache_key = 'private-products'${ownerId ? " AND owner_id = ?" : ""}`).bind(...args).all<SnapshotRow>(),
  ]);
  const rows = catalogResult.results ?? [];
  const catalogKeys = new Set(rows.map((row) => `${row.owner_id}\u0000${row.product_id}`));
  const orphanReferences: CatalogIdentityAudit["orphanReferences"] = [];

  const checkReferences = (source: string, references: ProductReferenceRow[]) => {
    for (const reference of references) {
      if (!catalogKeys.has(`${reference.owner_id}\u0000${reference.product_id}`)) {
        orphanReferences.push({ source, ownerId: reference.owner_id, productId: reference.product_id });
      }
    }
  };
  checkReferences("holdings", holdingResult.results ?? []);
  checkReferences("holding_positions", positionResult.results ?? []);
  checkReferences("product_overrides", overrideResult.results ?? []);
  checkReferences("hidden_products", hiddenResult.results ?? []);
  checkReferences("hidden_seed_products", hiddenSeedResult.results ?? []);

  for (const snapshot of snapshotResult.results ?? []) {
    const payload = parseJson(snapshot.payload);
    if (!payload) continue;
    const ids = new Set<string>([
      ...Object.keys(asRecord(payload.holdingUpdates)),
      ...Object.keys(asRecord(payload.holdingFallbacks)),
      ...asStringArray(payload.holdingSourceIds),
      ...asProductIds(payload.holdingPositions),
      ...asProductIds(payload.products),
      ...asProductIds(payload.rates),
    ]);
    for (const productId of ids) {
      if (!catalogKeys.has(`${snapshot.owner_id}\u0000${productId}`)) {
        orphanReferences.push({ source: "sync_snapshots", ownerId: snapshot.owner_id, productId });
      }
    }
  }

  const duplicateIdentityGroups = grouped(rows, (row) => `${row.owner_id}\u0000${row.identity_key}`)
    .filter((group) => group.length > 1);
  const activeCanonicalGroups = grouped(rows.filter((row) => row.status === "active"), (row) => `${row.owner_id}\u0000${row.canonical_product_id}`)
    .filter((group) => group.length > 1);
  const generatedProductIds = rows.filter((row) => /^api-[a-z0-9]/i.test(row.product_id));
  const activeRows = rows.filter((row) => row.status === "active").length;
  const owners = new Set(rows.map((row) => row.owner_id)).size;
  return {
    rows,
    duplicateIdentityGroups,
    activeCanonicalGroups,
    generatedProductIds,
    orphanReferences,
    summary: {
      owners,
      catalogRows: rows.length,
      activeRows,
      duplicateIdentityGroups: duplicateIdentityGroups.length,
      activeCanonicalGroups: activeCanonicalGroups.length,
      generatedProductIds: generatedProductIds.length,
      orphanReferences: orphanReferences.length,
      needsMigrationReview: duplicateIdentityGroups.length > 0 || orphanReferences.length > 0,
    },
  };
}

function grouped<T>(values: T[], keyOf: (value: T) => string) {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return [...groups.values()];
}

function parseJson(value: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asProductIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const productId = (item as { productId?: unknown }).productId;
    return typeof productId === "string" ? [productId] : [];
  });
}
