import type { D1Database } from "@cloudflare/workers-types";
import type { HoldingMap, HoldingPosition } from "@/lib/domain";
import { holdingPositionKey } from "@/lib/holding-cache";
import type { ProductOverrideMap } from "@/lib/product-overrides";
import { applyProductOverride } from "@/lib/product-overrides";
import { loadCatalogProducts } from "@/lib/product-catalog";
import { loadUserProducts } from "@/lib/user-products";
import { buildManualMaturityEvents, buildSyncChangeEvents, prepareProductChangeEventStatements, type ProductSnapshotForChanges } from "@/lib/product-change-events";
import { diagnosticErrorKind, syncDiagnostic, withSyncDiagnostics } from "@/lib/sync-diagnostics";
import { prepareDailyRefreshMarker, prepareRefreshCommitGuard, renewRefresh } from "@/lib/refresh-control";
import { loadSyncCache, prepareSyncCacheSave, prepareSyncFailureRecord, privateCacheKey, recordSyncAttempt, recordSyncFailure } from "@/lib/sync-cache";
import type { PrivateProductsPayload, RefreshOptions } from "./types";
import { refreshSource, safeCacheError } from "./status";
import { buildPrivatePayload } from "./payload";
import type { StartupServerTiming } from "@/lib/startup-timing";
import type { StartupTimingPhase } from "@/lib/startup-timing-format";

/** Minimum event count for reusing prefetched history, or null after an insert attempt. */
export async function recordDueManualMaturities(db: D1Database, userId: string, timing?: StartupServerTiming): Promise<number | null> {
  const measure = <T,>(phase: StartupTimingPhase, operation: () => Promise<T>) => timing ? timing.measure(phase, operation) : operation();
  const [catalogProducts, userProducts, holdingRows] = await Promise.all([
    measure("maturities_catalog", () => loadCatalogProducts(db, userId)),
    measure("maturities_user_products", () => loadUserProducts(db, userId)),
    // Only positive positions can produce maturity alerts. Join on both account
    // and product so one read replaces the four separate holding/override reads.
    measure("maturities_holdings", () => db.prepare(`SELECT h.product_id, h.amount, o.confirmed_apr, o.purchase_date,
        o.product_kind_override, o.updated_at, l.first_tier_limit, l.first_tier_unlimited, t.term_days
      FROM holdings h
      LEFT JOIN product_overrides o ON o.user_id = h.user_id AND o.product_id = h.product_id
      LEFT JOIN product_override_limits l ON l.user_id = h.user_id AND l.product_id = h.product_id
      LEFT JOIN product_override_terms t ON t.user_id = h.user_id AND t.product_id = h.product_id
      WHERE h.user_id = ? AND h.amount > 0`).bind(userId).all<{
        product_id: string; amount: number; confirmed_apr: number | null;
        purchase_date: string | null; product_kind_override: "flexible" | "fixed" | "limited" | null;
        updated_at: string | null; first_tier_limit: number | null; first_tier_unlimited: number | null; term_days: number | null;
      }>()),
  ]);
  const products = [...catalogProducts, ...userProducts].filter((product) => product.productDataMode === "manual");
  if (products.length === 0) return 0;
  const overrides = Object.fromEntries(holdingRows.results.map((row) => [row.product_id, {
    apr: row.confirmed_apr,
    firstTierLimit: row.first_tier_limit,
    ...(row.first_tier_unlimited == null ? {} : { firstTierUnlimited: row.first_tier_unlimited === 1 }),
    termDays: row.term_days,
    purchaseDate: row.purchase_date,
    updatedAt: row.updated_at,
    manualKind: row.product_kind_override,
  }])) as ProductOverrideMap;
  const resolvedProducts = products.map((product) => applyProductOverride(product, overrides[product.id]));
  const holdings = Object.fromEntries(holdingRows.results.map((row) => [row.product_id, Number(row.amount)])) as HoldingMap;
  const events = buildManualMaturityEvents(resolvedProducts, holdings, overrides);
  if (events.length === 0) return 0;

  // Read the existing IDs and history count from the same database snapshot.
  const { results } = await measure("maturities_lookup", () => db.prepare(`SELECT recorded.event_id,
      COALESCE((SELECT event_count FROM product_history_state WHERE owner_id = ?), 0) AS history_event_count
    FROM json_each(?) AS candidate
    LEFT JOIN product_change_events recorded ON recorded.owner_id = ? AND recorded.event_id = candidate.value`)
    .bind(userId, JSON.stringify(events.map((event) => event.id)), userId)
    .all<{ event_id: string | null; history_event_count: number }>());
  const recordedIds = new Set(results.map((row) => row.event_id));
  const newEvents = events.filter((event) => !recordedIds.has(event.id));
  if (newEvents.length === 0) return results[0]!.history_event_count;

  await measure("maturities_commit", () => db.batch(prepareProductChangeEventStatements(db, userId, newEvents)));
  // Another request may have inserted the same alert after the lookup. In that
  // case INSERT OR IGNORE preserves its read state and we still reread history.
  return null;
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
        .bind(userId, productId, amount, payload.holdingFetchedAt?.[productId] ?? payload.fetchedAt));
    await db.batch([
      ...(options.leaseToken ? [prepareRefreshCommitGuard(db, userId, options.leaseToken)] : []),
      ...catalog.statements,
      ...apiHoldingStatements,
      ...prepareHoldingPositionStatements(db, userId, payload.holdingPositions),
      ...prepareProductChangeEventStatements(db, userId, changeEvents),
      prepareSyncCacheSave(db, userId, privateCacheKey, payload, payload.fetchedAt),
      ...(options.dailyDay && options.leaseToken
        ? [prepareDailyRefreshMarker(db, userId, options.leaseToken, options.dailyDay)]
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
          prepareDailyRefreshMarker(db, userId, options.leaseToken, options.dailyDay),
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
    "SELECT user_id FROM wallet_configs",
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
