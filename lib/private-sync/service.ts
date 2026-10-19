import type { D1Database } from "@cloudflare/workers-types";
import type { HoldingMap, HoldingPosition } from "@/lib/domain";
import type { ProductOverrideMap } from "@/lib/product-overrides";
import { applyProductOverride } from "@/lib/product-overrides";
import { loadCatalogProducts } from "@/lib/product-catalog";
import { loadUserProducts } from "@/lib/user-products";
import { buildManualMaturityEvents, buildSyncChangeEvents, prepareProductChangeEventStatements, type ProductSnapshotForChanges } from "@/lib/product-change-events";
import { diagnosticErrorKind, syncDiagnostic, withSyncDiagnostics } from "@/lib/sync-diagnostics";
import { prepareDailyRefreshCommit, prepareRefreshCommitGuard, renewRefresh } from "@/lib/refresh-control";
import { loadSyncCache, prepareSyncCacheSave, prepareSyncFailureRecord, recordSyncAttempt, recordSyncFailure } from "@/lib/sync-cache";
import type { PrivateProductsPayload, RefreshOptions } from "./types";
import { refreshSource, safeCacheError } from "./status";
import { buildPrivatePayload } from "./payload";

export const privateCacheKey = "private-products";

export async function recordDueManualMaturities(db: D1Database, userId: string) {
  const [catalogProducts, userProducts, holdingRows, overrideRows, limitRows, termRows] = await Promise.all([
    loadCatalogProducts(db, userId),
    loadUserProducts(db, userId),
    db.prepare("SELECT product_id, amount FROM holdings WHERE user_id = ?").bind(userId).all<{ product_id: string; amount: number }>(),
    db.prepare("SELECT product_id, confirmed_apr, purchase_date, product_kind_override, updated_at FROM product_overrides WHERE user_id = ?").bind(userId).all<{ product_id: string; confirmed_apr: number | null; purchase_date: string | null; product_kind_override: "flexible" | "fixed" | "limited" | null; updated_at: string }>(),
    db.prepare("SELECT product_id, first_tier_limit FROM product_override_limits WHERE user_id = ?").bind(userId).all<{ product_id: string; first_tier_limit: number | null }>(),
    db.prepare("SELECT product_id, term_days FROM product_override_terms WHERE user_id = ?").bind(userId).all<{ product_id: string; term_days: number | null }>(),
  ]);
  const products = [...catalogProducts, ...userProducts].filter((product) => product.productDataMode === "manual");
  if (products.length === 0) return;
  const limits = new Map(limitRows.results.map((row) => [row.product_id, row.first_tier_limit]));
  const terms = new Map(termRows.results.map((row) => [row.product_id, row.term_days]));
  const overrides = Object.fromEntries(overrideRows.results.map((row) => [row.product_id, {
    apr: row.confirmed_apr,
    firstTierLimit: limits.get(row.product_id) ?? null,
    termDays: terms.get(row.product_id) ?? null,
    purchaseDate: row.purchase_date,
    updatedAt: row.updated_at,
    manualKind: row.product_kind_override,
  }])) as ProductOverrideMap;
  const resolvedProducts = products.map((product) => applyProductOverride(product, overrides[product.id]));
  const holdings = Object.fromEntries(holdingRows.results.map((row) => [row.product_id, Number(row.amount)])) as HoldingMap;
  const events = buildManualMaturityEvents(resolvedProducts, holdings, overrides);
  if (events.length > 0) await db.batch(prepareProductChangeEventStatements(db, userId, events));
}

export async function refreshPrivateProductsCache(db: D1Database, userId: string, options: RefreshOptions = {}) {
  return withSyncDiagnostics(userId, {
    trigger: options.trigger ?? "manual", attempt: options.attempt ?? 1, runId: options.runId,
  }, async () => {
    const startedAt = Date.now();
    const progress = { committed: false };
    syncDiagnostic("sync_started");
    try {
      const saved = await refreshPrivateProductsAttempt(db, userId, options, progress);
      syncDiagnostic("sync_finished", { outcome: saved.payload?.partial ? "partial" : "success", committed: true, durationMs: Date.now() - startedAt }, Boolean(saved.payload?.partial));
      return saved;
    } catch (error) {
      syncDiagnostic("sync_finished", { outcome: "error", errorKind: diagnosticErrorKind(error), committed: progress.committed, finalAttempt: options.persistFailure !== false, durationMs: Date.now() - startedAt }, true);
      throw error;
    }
  });
}

async function refreshPrivateProductsAttempt(db: D1Database, userId: string, options: RefreshOptions, progress: { committed: boolean }) {
  const {
    manual = false,
    acceptPartial = true,
    persistFailure = true,
    recordAttempt = true,
  } = options;
  const cached = await loadSyncCache<PrivateProductsPayload>(db, userId, privateCacheKey);
  if (recordAttempt) await recordSyncAttempt(db, userId, privateCacheKey, manual);
  try {
    const { payload, catalog, retryable } = await buildPrivatePayload(db, userId, cached);
    if (options.leaseToken && !await renewRefresh(db, userId, options.leaseToken)) throw new Error("refresh lease expired");
    if (retryable && !acceptPartial) throw new Error("已配置平台未完整同步");
    const changeEvents = buildSyncChangeEvents(
      cached?.payload as ProductSnapshotForChanges | null | undefined,
      payload,
      refreshSource(options.trigger),
      payload.fetchedAt,
    );
    const apiHoldingStatements = Object.entries(payload.holdingUpdates)
      .filter(([productId, amount]) => (catalog.authoritativeZeroProductIds.includes(productId)
        || catalog.products.some((product) => product.id === productId && product.holdingDataMode === "api"))
        && payload.holdingSyncStates[productId] === "synced"
        && !Object.hasOwn(payload.holdingFallbacks, productId)
        && Number.isFinite(amount) && amount >= 0)
      .map(([productId, amount]) => db.prepare(`INSERT INTO holdings (user_id, product_id, amount, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, product_id)
        DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at`)
        .bind(userId, productId, amount, payload.fetchedAt));
    await db.batch([
      ...(options.leaseToken ? [prepareRefreshCommitGuard(db, userId, options.leaseToken)] : []),
      ...catalog.statements,
      ...apiHoldingStatements,
      ...prepareHoldingPositionStatements(db, userId, payload.holdingPositions),
      ...prepareProductChangeEventStatements(db, userId, changeEvents),
      prepareSyncCacheSave(db, userId, privateCacheKey, payload, payload.fetchedAt),
      ...(options.dailyDay && options.leaseToken
        ? [prepareDailyRefreshCommit(db, userId, options.leaseToken, options.dailyDay)]
        : []),
    ]);
    progress.committed = true;
    if (options.dailyDay) syncDiagnostic("daily_refresh_committed", { day: options.dailyDay, result: payload.partial ? "partial" : "success" });
    return (await loadSyncCache<PrivateProductsPayload>(db, userId, privateCacheKey))!;
  } catch (error) {
    const leaseStillOwned = !options.leaseToken || await renewRefresh(db, userId, options.leaseToken);
    if (!leaseStillOwned) throw new Error("refresh lease expired");
    if (persistFailure && (!progress.committed || !options.dailyDay)) {
      if (options.dailyDay && options.leaseToken) {
        await db.batch([
          prepareRefreshCommitGuard(db, userId, options.leaseToken),
          prepareSyncFailureRecord(db, userId, privateCacheKey, safeCacheError(error)),
          prepareDailyRefreshCommit(db, userId, options.leaseToken, options.dailyDay),
        ]);
        syncDiagnostic("daily_refresh_committed", { day: options.dailyDay, result: "failure" }, true);
      } else {
        await recordSyncFailure(db, userId, privateCacheKey, safeCacheError(error));
      }
    }
    throw error;
  }
}

export async function listPrivateSyncUserIds(db: D1Database) {
  // Keep each read as a simple SELECT. D1 can reject a compound UNION query
  // with SQLITE_ERROR even when it only contains a handful of branches.
  const statements = [
    "SELECT user_id FROM exchange_credentials",
    "SELECT user_id FROM holdings",
    "SELECT user_id FROM holding_positions",
    "SELECT user_id FROM user_products",
    "SELECT owner_id AS user_id FROM sync_snapshots",
    "SELECT owner_id AS user_id FROM product_catalog",
  ].map((query) => db.prepare(query));
  const results = await Promise.all(statements.map((statement) => statement.all<{ user_id: string }>()));
  return [...new Set(results.flatMap((result) => result.results.map((row) => row.user_id)))].sort();
}

function prepareHoldingPositionStatements(db: D1Database, userId: string, positions: HoldingPosition[]) {
  const statements = [db.prepare("DELETE FROM holding_positions WHERE user_id = ?").bind(userId)];
  for (const position of positions) {
    statements.push(db.prepare(`INSERT INTO holding_positions
        (user_id, product_id, position_key, amount, purchase_at, redeem_at, source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, product_id, position_key)
        DO UPDATE SET amount = excluded.amount, purchase_at = excluded.purchase_at,
          redeem_at = excluded.redeem_at, source = excluded.source, updated_at = excluded.updated_at`)
      .bind(userId, position.productId, holdingPositionKey(position), position.amount,
        position.purchaseAt ?? null, position.redeemAt ?? null, position.source, position.updatedAt));
  }
  return statements;
}

function holdingPositionKey(position: Pick<HoldingPosition, "productId" | "positionId" | "purchaseAt" | "redeemAt">) {
  return [position.productId, position.positionId ?? "", position.purchaseAt ?? "", position.redeemAt ?? ""].join("\u0000");
}
