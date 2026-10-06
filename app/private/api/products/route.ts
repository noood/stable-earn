import type { D1Database } from "@cloudflare/workers-types";
import { NextResponse } from "next/server";
import { fetchBinanceFlexibleSnapshot, fetchBinanceLockedSnapshot, type BinanceFlexibleSnapshot, type BinanceLockedSnapshot } from "@/lib/integrations/binance";
import { fetchBitgetFixedSnapshot, fetchBitgetSavingsSnapshot, type BitgetSavingsSnapshot } from "@/lib/integrations/bitget";
import { bybitGlobalApiBases, fetchBybitFlexibleHoldings, fetchBybitShortFixedSnapshots } from "@/lib/integrations/bybit";
import { fetchOkxSavingsHoldings } from "@/lib/integrations/okx";
import { loadCredentials } from "@/lib/credentials";
import { getDatabase, getUserIdentity, isScheduledSyncEnabled } from "@/lib/db";
import { fetchPublicRateSnapshot, summarizePublicFailures, type ApiFieldNotice, type LiveRate } from "@/lib/live-rates";
import { isSameOriginMutation, privateResponseHeaders } from "@/lib/request-security";
import { mergeRates } from "@/lib/rate-cache";
import { loadManualRefreshCooldown, manualRefreshCooldownMs } from "@/lib/user-settings";
import { isLocalPreviewRequest, localPreviewTime, localPrivateProductsPreview, localSyncScenarioPreview } from "@/lib/local-preview";
import { cachedHoldingTimes, mergeHoldingPositions } from "@/lib/holding-cache";
import { compareProductIdentity, type ProductIdentityChange } from "@/lib/product-identity";
import { buildManualMaturityEvents, buildSyncChangeEvents, loadProductChangeEvents, prepareProductChangeEventStatements, type ProductChangeSource, type ProductSnapshotForChanges } from "@/lib/product-change-events";
import { loadCatalogProducts, prepareProductCatalogSync, resolveCatalogProductAccounts, resolveCatalogProductIds, type ProductCatalogSync } from "@/lib/product-catalog";
import type { HoldingMap, HoldingPosition, HoldingSyncState, Product } from "@/lib/domain";
import type { ProductOverrideMap } from "@/lib/product-overrides";
import { loadUserProducts } from "@/lib/user-products";
import { authoritativeEmptyHoldingScopeKeys, platformCapabilityScopeKey } from "@/lib/platform-capabilities";
import { diagnosticErrorKind, syncDiagnostic, withSyncDiagnostics, withSyncPlatform } from "@/lib/sync-diagnostics";
import { acquireRefresh, claimDailyRefresh, refreshIsLocked, releaseRefresh, renewRefresh } from "@/lib/refresh-control";
import { sanitizeSyncFailure, scheduledRefreshPending } from "@/lib/sync-notice";
import {
  formatCacheTime,
  loadSyncCache,
  manualCooldownUntil,
  prepareSyncCacheSave,
  recordSyncAttempt,
  recordSyncFailure,
  syncAttemptInProgress,
  syncCacheMetadata,
  type SyncCacheRecord,
  type SyncCacheState,
} from "@/lib/sync-cache";

type PrivateStatus = "not_configured" | "synced" | "partial" | "error";
type PrivateResult<T> = { snapshot: T | null; status: PrivateStatus; diagnostic?: string };
type BinanceAccountSnapshot = Omit<BinanceFlexibleSnapshot, "productApiStatus" | "positionApiStatus"> & {
  sync: { flexible: boolean; locked: boolean };
  apiStatuses: {
    flexibleProducts: "complete" | "partial" | "error";
    flexibleHoldings: "complete" | "partial" | "error";
    fixedProducts: "complete" | "partial" | "error";
    fixedHoldings: "complete" | "partial" | "error";
  };
  positions: BinanceLockedSnapshot["positions"];
  lockedProductListComplete: boolean;
  lockedPositionListComplete: boolean;
};
type PrivateStatuses = {
  binanceGlobal: PrivateStatus;
  binanceBahrain: PrivateStatus;
  bybitGlobal: PrivateStatus;
  bitget: PrivateStatus;
  okx: PrivateStatus;
};
type PrivateDiagnostics = Partial<Record<keyof PrivateStatuses, string>>;
type PrivateProductsPayload = {
  products: Product[];
  rates: LiveRate[];
  rateFallbacks: Record<string, string>;
  holdingUpdates: Record<string, number>;
  holdingSourceIds: string[];
  holdingFallbacks: Record<string, string>;
  holdingSyncStates: Record<string, HoldingSyncState>;
  holdingPositions: HoldingPosition[];
  apiFieldNotices?: ApiFieldNotice[];
  fetchedAt: string;
  partial: boolean;
  note: string;
  failures?: string[];
  fallbackUpdatedAt?: string | null;
  identityChanges?: Record<string, ProductIdentityChange>;
};
type PrivatePayloadBuild = {
  payload: PrivateProductsPayload;
  catalog: ProductCatalogSync;
  retryable: boolean;
};
type RefreshOptions = {
  leaseToken?: string;
  trigger?: "scheduled" | "manual" | "daily";
  attempt?: number;
  runId?: string;
  manual?: boolean;
  acceptPartial?: boolean;
  persistFailure?: boolean;
  recordAttempt?: boolean;
};

const privateCacheKey = "private-products";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (params.has("refresh") || params.has("visit")) {
    return NextResponse.json({ error: "刷新请求必须使用 POST。" }, {
      status: 405,
      headers: { ...privateResponseHeaders, Allow: "POST" },
    });
  }
  return handleProductsRequest(request, false);
}

export async function POST(request: Request) {
  const identity = await getUserIdentity(request);
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  if (!isSameOriginMutation(request)) return NextResponse.json({ error: "请求来源无效。" }, { status: 403, headers: privateResponseHeaders });

  const params = new URL(request.url).searchParams;
  const refresh = params.get("refresh");
  const visit = params.get("visit");
  const validValues = (refresh === null || refresh === "1") && (visit === null || visit === "1");
  if (!validValues || (refresh === "1") === (visit === "1")) {
    return NextResponse.json({ error: "请指定一种有效的刷新方式。" }, {
      status: 400,
      headers: { ...privateResponseHeaders, Allow: "GET, POST" },
    });
  }
  return handleProductsRequest(request, true, identity);
}

async function handleProductsRequest(request: Request, refreshAllowed: boolean, knownIdentity?: Awaited<ReturnType<typeof getUserIdentity>>) {
  const identity = knownIdentity ?? await getUserIdentity(request);
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  const ownerId = identity.userId;
  const scheduledSyncEnabled = isScheduledSyncEnabled();
  if (isLocalPreviewRequest(request)) {
    const scenario = new URL(request.url).searchParams.get("syncScenario");
    if (scenario === "product-read-error" || scenario === "both-read-error") {
      return NextResponse.json({ error: "本地模拟：交易所缓存读取失败" }, { status: 503, headers: privateResponseHeaders });
    }
    const previewNow = localPreviewTime(request.url);
    const preview = localSyncScenarioPreview(scenario, previewNow) ?? localPrivateProductsPreview(previewNow);
    const responsePreview = !scheduledSyncEnabled && preview.cache
      ? { ...preview, cache: { ...preview.cache, scheduledAt: null, scheduledState: "disabled" as const } }
      : preview;
    return NextResponse.json(responsePreview, { status: scenario === "initial-error" ? 502 : 200, headers: privateResponseHeaders });
  }

  const db = await getDatabase();
  const params = new URL(request.url).searchParams;
  const manual = refreshAllowed && params.get("refresh") === "1";
  const daily = refreshAllowed && !manual && params.get("visit") === "1";
  const manualCooldownDuration = manualRefreshCooldownMs(await loadManualRefreshCooldown(db, identity.userId));
  let pending = false;
  async function reply(response: Response) {
    const body = await response.json() as Record<string, unknown>;
    const cache = body.cache;
    if (!scheduledSyncEnabled && cache && typeof cache === "object" && !Array.isArray(cache)) {
      body.cache = { ...(cache as Record<string, unknown>), scheduledAt: null, scheduledState: "disabled" };
    }
    await recordDueManualMaturities(db, ownerId);
    const changeEvents = await loadProductChangeEvents(db, ownerId);
    return NextResponse.json({ ...body, changeEvents, dailyRefreshPending: daily && pending }, {
      status: response.status, headers: privateResponseHeaders,
    });
  }
  function snapshot(record: SyncCacheRecord<PrivateProductsPayload> | null, busy = false) {
    const now = Date.now();
    const state = busy || syncAttemptInProgress(record, now) ? "syncing" : record?.lastError ? "error" : "fresh";
    if (record?.payload) return cachedResponse(record, state,
      state === "syncing" ? "正在更新数据中，请稍候。" : "已读取保存的数据。", now, manualCooldownDuration);
    if (state === "error" && record) return initialErrorResponse(record, now, manualCooldownDuration);
    return initialSyncingResponse(record, now, manualCooldownDuration, state);
  }

  // Ordinary polls never contact exchanges, including accounts without a cache.
  if (!manual && !daily) {
    const busy = await refreshIsLocked(db, identity.userId);
    return reply(snapshot(await loadSyncCache(db, identity.userId, privateCacheKey), busy));
  }
  const token = await acquireRefresh(db, identity.userId);
  if (!token) {
    pending = true;
    return reply(snapshot(await loadSyncCache(db, identity.userId, privateCacheKey), true));
  }
  try {
    const cached = await loadSyncCache<PrivateProductsPayload>(db, identity.userId, privateCacheKey);
    const now = Date.now();
    // Reserve the whole scheduled retry window, not just an individual request.
    if (scheduledSyncEnabled && scheduledRefreshPending(now, syncCacheMetadata(cached, syncAttemptInProgress(cached, now) ? "syncing" : "fresh", now))) {
      pending = true;
      return reply(snapshot(cached, true));
    }
    if (daily && !await claimDailyRefresh(db, identity.userId, token)) return reply(snapshot(cached));
    const cooldownUntil = manualCooldownUntil(cached, now, manualCooldownDuration);
    if (manual && cooldownUntil) {
      if (cached?.payload) return reply(cachedResponse(cached, "cooldown", `手动刷新冷却中，可在 ${formatCacheTime(cooldownUntil)} 后重试。`, now, manualCooldownDuration));
      return reply(NextResponse.json({ error: `手动刷新冷却中，可在 ${formatCacheTime(cooldownUntil)} 后重试。` }, { status: 429 }));
    }
    try {
      const saved = await refreshPrivateProductsCache(db, identity.userId, { manual, trigger: daily ? "daily" : "manual", leaseToken: token });
      return reply(cachedResponse(saved, "updated", "已完成刷新。", Date.now(), manualCooldownDuration));
    } catch {
      return reply(snapshot(await loadSyncCache(db, identity.userId, privateCacheKey)));
    }
  } finally {
    await releaseRefresh(db, identity.userId, token);
  }
}

async function recordDueManualMaturities(db: D1Database, userId: string) {
  const [catalogProducts, userProducts, holdingRows, overrideRows, limitRows, termRows] = await Promise.all([
    loadCatalogProducts(db, userId),
    loadUserProducts(db, userId),
    db.prepare("SELECT product_id, amount FROM holdings WHERE user_id = ?").bind(userId).all<{ product_id: string; amount: number }>(),
    db.prepare("SELECT product_id, confirmed_apr, purchase_date, updated_at FROM product_overrides WHERE user_id = ?").bind(userId).all<{ product_id: string; confirmed_apr: number | null; purchase_date: string | null; updated_at: string }>(),
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
  }])) as ProductOverrideMap;
  const resolvedProducts = products.map((product) => {
    const overrideTerm = terms.get(product.id);
    return overrideTerm && overrideTerm > 0 ? { ...product, termDays: overrideTerm } : product;
  });
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
      .filter(([productId, amount]) => catalog.products.some((product) => product.id === productId && product.holdingDataMode === "api")
        && payload.holdingSyncStates[productId] === "synced"
        && !Object.hasOwn(payload.holdingFallbacks, productId)
        && Number.isFinite(amount) && amount >= 0)
      .map(([productId, amount]) => db.prepare(`INSERT INTO holdings (user_id, product_id, amount, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, product_id)
        DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at`)
        .bind(userId, productId, amount, payload.fetchedAt));
    await db.batch([
      ...catalog.statements,
      ...apiHoldingStatements,
      ...prepareHoldingPositionStatements(db, userId, payload.holdingPositions),
      ...prepareProductChangeEventStatements(db, userId, changeEvents),
      prepareSyncCacheSave(db, userId, privateCacheKey, payload, payload.fetchedAt),
    ]);
    progress.committed = true;
    return (await loadSyncCache<PrivateProductsPayload>(db, userId, privateCacheKey))!;
  } catch (error) {
    if (persistFailure && (!options.leaseToken || await renewRefresh(db, userId, options.leaseToken))) {
      await recordSyncFailure(db, userId, privateCacheKey, safeCacheError(error));
    }
    throw error;
  }
}

function refreshSource(trigger: RefreshOptions["trigger"]): ProductChangeSource {
  if (trigger === "daily") return "每日首次打开";
  if (trigger === "scheduled") return "定时刷新";
  return "手动刷新";
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

async function buildPrivatePayload(
  db: D1Database,
  userId: string,
  cached: SyncCacheRecord<PrivateProductsPayload> | null,
): Promise<PrivatePayloadBuild> {
  const credentials = await loadCredentials(db, userId);
  const publicSnapshotPromise = withSyncPlatform("public", fetchPublicRateSnapshot);
  const binanceGlobalCredential = credentials["binance-global"];
  const binanceGlobalJob = runPrivate(
    "binance-global",
    Boolean(binanceGlobalCredential),
    () => fetchBinanceAccountSnapshot({
      apiKey: binanceGlobalCredential!.apiKey,
      apiSecret: binanceGlobalCredential!.apiSecret,
    }, "global"),
  );
  const binanceBahrainCredential = credentials["binance-bahrain"];
  const binanceBahrainJob = runPrivate(
    "binance-bahrain",
    Boolean(binanceBahrainCredential),
    () => fetchBinanceAccountSnapshot({
      apiKey: binanceBahrainCredential!.apiKey,
      apiSecret: binanceBahrainCredential!.apiSecret,
    }, "bahrain"),
  );
  const bybitGlobalCredential = credentials["bybit-global"];
  const bybitGlobalJob = runPrivate(
    "bybit-global",
    Boolean(bybitGlobalCredential),
    async () => {
      const bybitCredentials = {
        apiKey: bybitGlobalCredential!.apiKey,
        apiSecret: bybitGlobalCredential!.apiSecret,
        baseUrls: bybitGlobalApiBases,
      };
      const [flexible, fixed] = await Promise.all([
        fetchBybitFlexibleHoldings(bybitCredentials, "global"),
        fetchBybitShortFixedSnapshots(bybitCredentials),
      ]);
      const failedScopes = [
        ...flexible.sync.failedAssets.map((asset) => `活期持仓请求失败:${asset}`),
        ...flexible.sync.partialAssets.map((asset) => `活期持仓部分返回:${asset}`),
        fixed.sync.productStatus !== "complete" ? `定期产品${fixed.sync.productStatus === "error" ? "请求失败" : "部分返回"}` : null,
        fixed.sync.holdingStatus !== "complete" ? `定期持仓${fixed.sync.holdingStatus === "error" ? "请求失败" : "部分返回"}` : null,
      ].filter((scope): scope is string => Boolean(scope));
      const flexibleStatus = flexible.sync.failedAssets.length === 0 && flexible.sync.partialAssets.length === 0
        ? "complete" as const
        : flexible.sync.failedAssets.length === 0 || flexible.sync.successfulAssets.length > 0 || flexible.sync.partialAssets.length > 0
          ? "partial" as const
          : "error" as const;
      return {
        holdings: { ...flexible.holdings, ...fixed.holdings },
        rates: [...flexible.rates, ...fixed.rates],
        failedScopes,
        apiStatuses: [flexibleStatus, fixed.sync.productStatus, fixed.sync.holdingStatus] as const,
      };
    },
  );
  const bitgetCredential = credentials["bitget-global"];
  const bitgetJob = runPrivate(
    "bitget-global",
    Boolean(bitgetCredential?.passphrase),
    async () => {
      const credential = {
        apiKey: bitgetCredential!.apiKey,
        apiSecret: bitgetCredential!.apiSecret,
        passphrase: bitgetCredential!.passphrase!,
      };
      const [flexible, fixed] = await Promise.allSettled([
        fetchBitgetSavingsSnapshot(credential),
        fetchBitgetFixedSnapshot(credential),
      ]);
      if (flexible.status === "rejected" && fixed.status === "rejected") throw new Error("Bitget flexible and fixed Savings APIs unavailable");
      const flexSnapshot = flexible.status === "fulfilled" ? flexible.value : null;
      const fixedSnapshot = fixed.status === "fulfilled" ? fixed.value : null;
      const flexibleProductStatus = flexSnapshot?.sync.productStatus ?? (flexSnapshot?.sync.products ? "complete" : "partial");
      const fixedProductStatus = fixedSnapshot?.sync.productStatus ?? (fixedSnapshot?.sync.products ? "complete" : fixedSnapshot ? "partial" : "error");
      const flexibleHoldingStatus = flexSnapshot?.sync.holdingStatus ?? (flexSnapshot?.sync.holdings ? "complete" : "partial");
      const fixedHoldingStatus = fixedSnapshot?.sync.holdingStatus ?? (fixedSnapshot?.sync.holdings ? "complete" : fixedSnapshot ? "partial" : "error");
      const productStatus = combineApiReadStatuses([flexibleProductStatus, fixedProductStatus]);
      const holdingStatus = combineApiReadStatuses([flexibleHoldingStatus, fixedHoldingStatus]);
      const productScopes = [
        { label: "活期产品", status: flexibleProductStatus },
        { label: "定期产品", status: fixedProductStatus },
      ].filter((scope) => scope.status !== "complete").map((scope) => `${scope.label}${scope.status === "error" ? "请求失败" : "部分返回"}`);
      const holdingScopes = [
        { label: "活期持仓", status: flexibleHoldingStatus },
        { label: "定期持仓", status: fixedHoldingStatus },
      ].filter((scope) => scope.status !== "complete").map((scope) => `${scope.label}${scope.status === "error" ? "请求失败" : "部分返回"}`);
      return {
        rates: [...(flexSnapshot?.rates ?? []), ...(fixedSnapshot?.rates ?? [])],
        holdings: { ...(flexSnapshot?.holdings ?? {}), ...(fixedSnapshot?.holdings ?? {}) },
        sync: {
          products: productStatus === "complete",
          holdings: holdingStatus === "complete",
          productStatus,
          holdingStatus,
          productDiagnostic: productScopes.length ? `scopes:${productScopes.join("|")}` : undefined,
          holdingsDiagnostic: holdingScopes.length ? `scopes:${holdingScopes.join("|")}` : undefined,
        },
      } satisfies BitgetSavingsSnapshot;
    },
  );
  const okxCredential = credentials["okx-global"];
  const okxJob = runPrivate(
    "okx-global",
    Boolean(okxCredential?.passphrase),
    () => fetchOkxSavingsHoldings({
      apiKey: okxCredential!.apiKey,
      apiSecret: okxCredential!.apiSecret,
      passphrase: okxCredential!.passphrase!,
    }),
  );
  const [publicSnapshot, binanceGlobalResult, binanceBahrainResult, bybitGlobalResult, bitgetResult, okxResult] = await Promise.all([
    publicSnapshotPromise,
    binanceGlobalJob,
    binanceBahrainJob,
    bybitGlobalJob,
    bitgetJob,
    okxJob,
  ]);
  const okxInvalidAssets = okxResult.snapshot?.invalidAssets ?? [];
  const okxSnapshotIncomplete = okxResult.status === "synced"
    && okxResult.snapshot?.snapshotComplete !== true;
  const okxStatus: PrivateStatus = okxResult.status === "synced" && (okxInvalidAssets.length > 0 || okxSnapshotIncomplete)
    ? "partial"
    : okxResult.status;
  const okxDiagnostic = okxInvalidAssets.length > 0
    ? `unreadable_balance:${okxInvalidAssets.join(",")}`
    : okxSnapshotIncomplete
      ? "incomplete_balance_response"
      : okxResult.diagnostic;
  const publicRates = publicSnapshot.rates;
  const publicFailures = publicSnapshot.failures;
  const publicPartials = publicSnapshot.partials ?? [];
  const publicEmpty = publicSnapshot.empty ?? [];
  const binanceGlobal: BinanceAccountSnapshot | null = binanceGlobalResult.snapshot;
  const binanceBahrain: BinanceAccountSnapshot | null = binanceBahrainResult.snapshot;
  const binanceGlobalStatus = resolveBinanceStatus(binanceGlobal, binanceGlobalResult.status);
  const binanceBahrainStatus = resolveBinanceStatus(binanceBahrain, binanceBahrainResult.status);
  const binanceGlobalDiagnostic = binanceScopes(binanceGlobal) ?? binanceGlobalResult.diagnostic;
  const binanceBahrainDiagnostic = binanceScopes(binanceBahrain) ?? binanceBahrainResult.diagnostic;
  const bybitGlobal = bybitGlobalResult.snapshot;
  const bybitGlobalStatus: PrivateStatus = bybitGlobalResult.status !== "synced" || !bybitGlobal
    ? bybitGlobalResult.status
    : bybitGlobal.apiStatuses.every((status) => status === "error")
      ? "error"
      : bybitGlobal.apiStatuses.every((status) => status === "complete")
        ? "synced"
        : "partial";
  const bybitGlobalDiagnostic = bybitGlobal?.failedScopes.length
    ? `scopes:${bybitGlobal.failedScopes.join("|")}`
    : bybitGlobalResult.diagnostic;
  const bitget: BitgetSavingsSnapshot | null = bitgetResult.snapshot;
  const bitgetStatus: PrivateStatus = bitgetResult.status !== "synced" || !bitget
    ? bitgetResult.status
    : [bitget.sync.productStatus, bitget.sync.holdingStatus].every((status) => status === "error")
      ? "error"
      : bitget.sync.productStatus === "complete" && bitget.sync.holdingStatus === "complete"
        ? "synced"
        : "partial";
  const bitgetDiagnostic = bitget && (bitgetStatus === "partial" || bitgetStatus === "error")
    ? `scopes:${[
      ...(bitget.sync.productDiagnostic?.startsWith("scopes:") ? bitget.sync.productDiagnostic.slice("scopes:".length).split("|") : []),
      ...(bitget.sync.holdingsDiagnostic?.startsWith("scopes:") ? bitget.sync.holdingsDiagnostic.slice("scopes:".length).split("|") : []),
    ].filter(Boolean).join("|")}`
    : bitgetResult.diagnostic;
  const freshRates: LiveRate[] = [
    ...publicRates,
    ...(binanceGlobal?.rates ?? []),
    ...(binanceBahrain?.rates ?? []),
    ...(bybitGlobal?.rates ?? []),
    ...(bitget?.rates ?? []),
  ];
  const apiFieldNotices: ApiFieldNotice[] = [
    ...(publicSnapshot.fieldNotices ?? []),
    ...freshRates.flatMap((rate) => rate.productDataMode !== "manual" && rate.rateCoverage === "unavailable" && rate.catalog
      ? [{ accountId: rate.catalog.accountId, asset: rate.catalog.asset, productName: rate.name ?? rate.externalProductId ?? rate.productId, externalProductId: rate.externalProductId, fields: ["APR 未获取"] }]
      : []),
  ];
  const freshHoldingUpdates = {
    ...(binanceGlobal?.holdings ?? {}),
    ...(binanceBahrain?.holdings ?? {}),
    ...(bybitGlobal?.holdings ?? {}),
    ...(bitget?.holdings ?? {}),
    ...(okxResult.snapshot?.holdings ?? {}),
  };
  const freshHoldingPositions = [
    ...(binanceGlobal?.positions ?? []).map((position) => ({ ...position, accountId: "binance-global" })),
    ...(binanceBahrain?.positions ?? []).map((position) => ({ ...position, accountId: "binance-bahrain" })),
  ];
  const fallbackRates = cached?.payload?.rates ?? [];
  const completeAccountIds = [
    binanceGlobalStatus === "synced"
      && binanceGlobal?.apiStatuses.flexibleProducts === "complete"
      && binanceGlobal?.apiStatuses.flexibleHoldings === "complete"
      && binanceGlobal?.apiStatuses.fixedProducts === "complete"
      && binanceGlobal?.apiStatuses.fixedHoldings === "complete" ? "binance-global" : null,
    binanceBahrainStatus === "synced"
      && binanceBahrain?.apiStatuses.flexibleProducts === "complete"
      && binanceBahrain?.apiStatuses.flexibleHoldings === "complete"
      && binanceBahrain?.apiStatuses.fixedProducts === "complete"
      && binanceBahrain?.apiStatuses.fixedHoldings === "complete" ? "binance-bahrain" : null,
    // Bybit's public product rows share this account id with private rows, so
    // only treat the account as complete when both private and public reads
    // succeeded. A public endpoint failure must not archive a cached product.
    bybitGlobalStatus === "synced" && publicFailures.length === 0 && publicPartials.length === 0 ? "bybit-global" : null,
    // Bitget's holding response is sparse. The adapter marks the account
    // complete only after every assets page has been read, so an absent
    // flexible offer is then an authoritative zero.
    bitgetStatus === "synced" && bitget?.sync.products && bitget?.sync.holdings ? "bitget-global" : null,
    // OKX returns coin-level balances without product IDs, but this project
    // tracks one active Savings product per monitored coin. Only a complete,
    // unambiguous response makes missing coin rows authoritative zeroes.
    okxStatus === "synced" && okxResult.snapshot?.snapshotComplete === true ? "okx-global" : null,
  ].filter((accountId): accountId is string => Boolean(accountId));
  const completeScopeKeys = authoritativeEmptyHoldingScopeKeys(completeAccountIds);
  // Catalog zero/absence evidence must stay inside the configured asset ×
  // product-type scopes. Passing a whole account ID here would make a
  // complete Bybit response authoritative for unsupported scopes such as
  // Bybit Global flexible USDGO.
  const catalog = await prepareProductCatalogSync(db, userId, freshRates, freshHoldingUpdates, [], completeScopeKeys);
  const activeProductIds = new Set(catalog.products.map((product) => product.id));
  const rates = mergeRates(catalog.rates, fallbackRates).filter((rate) => activeProductIds.has(rate.productId));
  const previousRates = new Map((cached?.payload?.rates ?? []).map((rate) => [rate.productId, rate]));
  const identityChanges = Object.fromEntries(catalog.rates.map((rate) => [
    rate.productId,
    compareProductIdentity(previousRates.get(rate.productId), rate),
  ]));
  const freshRateProductIds = new Set(catalog.rates.map((rate) => rate.productId));
  const fallbackRateTimes = new Map(rates
    .filter((rate) => !freshRateProductIds.has(rate.productId))
    .map((rate) => [rate.productId, rate.fetchedAt]));
  const rateFallbacks = Object.fromEntries(catalog.products
    .filter((product) => product.productDataMode === "api"
      && product.source.kind === "live"
      && !freshRateProductIds.has(product.id))
    .flatMap((product) => {
      const fallbackAt = fallbackRateTimes.get(product.id) ?? product.source.fetchedAt ?? cached?.updatedAt;
      return fallbackAt ? [[product.id, fallbackAt] as const] : [];
    }));
  const [storedProductIds, storedProductAccounts] = await Promise.all([
    resolveCatalogProductIds(db, userId),
    resolveCatalogProductAccounts(db, userId),
  ]);
  const catalogProductIds = { ...storedProductIds, ...catalog.productIds };
  const catalogProductAccounts = {
    ...storedProductAccounts,
    ...Object.fromEntries(catalog.products.map((product) => [product.id, product.accountId])),
  };
  const normalizedFreshHoldings: Record<string, number> = Object.fromEntries(Object.entries(freshHoldingUpdates)
    .map(([productId, amount]) => [normalizeCatalogHoldingId(productId, activeProductIds, catalogProductIds), amount]));
  for (const product of catalog.products) {
    if (product.holdingDataMode === "api"
      && completeScopeKeys.includes(platformCapabilityScopeKey(product.accountId, product.asset, product.productType))
      && !Object.prototype.hasOwnProperty.call(normalizedFreshHoldings, product.id)) {
      normalizedFreshHoldings[product.id] = 0;
    }
  }
  // A hidden API product must reappear as soon as a fresh, trusted sync finds
  // a positive balance. This prevents the hide action from masking a later
  // deposit while preserving the product row and its history.
  const hiddenRows = await db.prepare("SELECT product_id FROM hidden_products WHERE user_id = ?")
    .bind(userId).all<{ product_id: string }>();
  for (const row of hiddenRows.results) {
    if (Number(normalizedFreshHoldings[row.product_id]) > 0) {
      catalog.statements.push(db.prepare("DELETE FROM hidden_products WHERE user_id = ? AND product_id = ?")
        .bind(userId, row.product_id));
    }
  }
  const holdingUpdates = Object.fromEntries(Object.entries({
    ...(cached?.payload?.holdingUpdates ?? {}),
    ...normalizedFreshHoldings,
  }).map(([productId, amount]) => [normalizeCatalogHoldingId(productId, activeProductIds, catalogProductIds), amount] as const)
    .filter(([productId]) => activeProductIds.has(productId)));

  const positionUpdatedAt = new Date().toISOString();
  const normalizedHoldingPositions: HoldingPosition[] = freshHoldingPositions.flatMap((position) => {
    const productId = normalizeCatalogHoldingId(position.sourceProductId, activeProductIds, catalogProductIds);
    if (!productId || !activeProductIds.has(productId)) return [];
    return [{
      productId,
      accountId: position.accountId,
      positionId: position.positionId,
      amount: position.amount,
      purchaseAt: position.purchaseAt,
      redeemAt: position.redeemAt,
      source: "api" as const,
      updatedAt: positionUpdatedAt,
    }];
  });
  const holdingPositions = mergeHoldingPositions(
    cached?.payload?.holdingPositions ?? [],
    normalizedHoldingPositions,
    new Set(completeAccountIds),
    catalogProductAccounts,
  ).filter((position) => activeProductIds.has(position.productId));
  const freshHoldingProductIds = new Set(Object.keys(normalizedFreshHoldings));
  const privateStatus: PrivateStatuses = {
    binanceGlobal: binanceGlobalStatus,
    binanceBahrain: binanceBahrainStatus,
    bybitGlobal: bybitGlobalStatus,
    bitget: bitgetStatus,
    okx: okxStatus,
  };
  const holdingSyncStates = Object.fromEntries(catalog.products.flatMap((product) => {
    const state = productHoldingSyncState(product, privateStatus);
    return state ? [[product.id, state] as const] : [];
  }));
  const privateDiagnostics: PrivateDiagnostics = {
    binanceGlobal: binanceGlobalDiagnostic,
    binanceBahrain: binanceBahrainDiagnostic,
    bybitGlobal: bybitGlobalDiagnostic,
    bitget: bitgetDiagnostic,
    okx: okxDiagnostic,
  };
  const configuredError = Object.values(privateStatus).some((status) => status === "error" || status === "partial");
  const holdingFallbacks = Object.fromEntries(Object.entries(cachedHoldingTimes(
    cached?.payload?.holdingUpdates ?? {},
    cached?.payload?.holdingFallbacks ?? {},
    cached?.updatedAt ?? updatedFallbackTime(cached?.payload?.fetchedAt),
  ))
    .map(([productId, time]) => [normalizeCatalogHoldingId(productId, activeProductIds, catalogProductIds), time])
    .filter(([productId]) => activeProductIds.has(productId) && !freshHoldingProductIds.has(productId)));
  const successfulPrivateJobs = Object.values(privateStatus).filter((status) => status === "synced" || status === "partial").length;
  // Log before the all-failed throw, which deliberately preserves the old cache.
  syncDiagnostic("sync_platforms", {
    ...privateStatus,
    publicOutcome: publicFailures.length ? "error" : publicPartials.length ? "partial" : publicRates.length ? "returned" : "empty",
    publicEmptyScopes: publicEmpty,
    ...(bitget ? {
      bitgetProducts: bitget.sync.products,
      bitgetHoldings: bitget.sync.holdings,
      bitgetProductStatus: bitget.sync.productStatus,
      bitgetHoldingStatus: bitget.sync.holdingStatus,
    } : {}),
    ...(bybitGlobal ? { bybitFailedScopes: bybitGlobal.failedScopes } : {}),
  }, configuredError || publicFailures.length > 0);
  const configuredPrivateJobs = Object.values(privateStatus).filter((status) => status !== "not_configured");
  const everyConfiguredPrivateJobFailed = configuredPrivateJobs.length > 0
    && configuredPrivateJobs.every((status) => status === "error");
  if (publicRates.length === 0 && successfulPrivateJobs === 0
    && (publicFailures.length > 0 || everyConfiguredPrivateJobFailed)) {
    throw new Error("公开与账户接口均未返回可用数据");
  }

  const updatedAt = new Date().toISOString();
  const partial = publicFailures.length > 0 || publicPartials.length > 0 || configuredError;
  const failures = buildFailures(privateStatus, privateDiagnostics, publicFailures, publicPartials);
  const fallbackNote = partial && cached?.updatedAt
    ? `未成功更新的项目沿用 ${formatCacheTime(cached.updatedAt)} 的最近一次成功数据。`
    : "";
  return {
    catalog,
    retryable: configuredError || publicFailures.length > 0 || publicPartials.length > 0,
    payload: {
      products: catalog.products,
      rates,
      rateFallbacks,
      holdingUpdates,
      holdingSourceIds: [...new Set([
        ...(cached?.payload?.holdingSourceIds ?? []),
        ...Object.keys(normalizedFreshHoldings),
      ])].filter((productId) => activeProductIds.has(productId)),
      holdingFallbacks,
      holdingSyncStates,
      holdingPositions,
      apiFieldNotices,
      fetchedAt: updatedAt,
      partial,
      note: `${buildNote(failures)} ${fallbackNote}`.trim(),
      failures,
      fallbackUpdatedAt: failures.length > 0 ? cached?.updatedAt ?? null : null,
      identityChanges,
    },
  };
}

/**
 * Preserve an active catalog row when resolving aliases from older catalog
 * identities. A legacy alias may point at a different active row, but that
 * must never rewrite a current row's zero balance onto the legacy row (or the
 * reverse) during a failed-refresh fallback.
 */
export function normalizeCatalogHoldingId(
  productId: string,
  activeProductIds: ReadonlySet<string>,
  catalogProductIds: Record<string, string>,
) {
  return activeProductIds.has(productId) ? productId : catalogProductIds[productId] ?? productId;
}

function holdingPositionKey(position: Pick<HoldingPosition, "productId" | "positionId" | "purchaseAt" | "redeemAt">) {
  return [position.productId, position.positionId ?? "", position.purchaseAt ?? "", position.redeemAt ?? ""].join("\u0000");
}

function cachedResponse(
  record: SyncCacheRecord<PrivateProductsPayload>,
  state: SyncCacheState,
  statusText: string,
  now: number,
  manualCooldownDuration: number,
) {
  const payload = record.payload!;
  const failures = payload.failures ?? legacyFailures(payload.note);
  const failed = state === "error" || Boolean(record.lastError);
  const responseFailures = state === "syncing" ? [] : failed ? ["产品和持仓数据更新失败"] : failures.map(sanitizeSyncFailure);
  return NextResponse.json({
    ...payload,
    partial: state === "syncing" ? false : payload.partial,
    rateFallbacks: failed
      ? Object.fromEntries(payload.rates.map((rate) => [rate.productId, rate.fetchedAt || record.updatedAt]))
      : payload.rateFallbacks ?? {},
    holdingFallbacks: failed
      ? cachedHoldingTimes(payload.holdingUpdates, payload.holdingFallbacks ?? {}, record.updatedAt ?? payload.fetchedAt)
      : payload.holdingFallbacks ?? {},
    holdingSyncStates: failed
      ? Object.fromEntries(Object.entries(payload.holdingSyncStates ?? {}).map(([id, status]) => [id, status === "not_configured" ? status : "error"]))
      : payload.holdingSyncStates,
    holdingPositions: payload.holdingPositions ?? [],
    fetchedAt: record.updatedAt ?? payload.fetchedAt,
    cache: syncCacheMetadata(record, state, now, manualCooldownDuration),
    note: state === "syncing" ? statusText : `${statusText} ${normalizeLegacyNote(payload.note)}`.trim(),
    failures: responseFailures,
    fallbackUpdatedAt: state === "syncing" ? null : payload.fallbackUpdatedAt
      ?? (state === "error" ? record.updatedAt : null),
  }, { headers: privateResponseHeaders });
}

function initialSyncingResponse(
  record: SyncCacheRecord<PrivateProductsPayload> | null,
  now: number,
  manualCooldownDuration: number,
  state: SyncCacheState = "syncing",
) {
  return NextResponse.json({
    products: [],
    rates: [],
    rateFallbacks: {},
    holdingUpdates: {},
    holdingSourceIds: [],
    holdingFallbacks: {},
    holdingSyncStates: {},
    holdingPositions: [],
    partial: false,
    note: state === "syncing" ? "正在更新数据中，请稍候。" : "尚无成功数据。",
    failures: [],
    fallbackUpdatedAt: null,
    cache: syncCacheMetadata(record, state, now, manualCooldownDuration),
  }, { headers: privateResponseHeaders });
}

function initialErrorResponse(
  record: SyncCacheRecord<PrivateProductsPayload>,
  now: number,
  manualCooldownDuration: number,
) {
  return NextResponse.json({
    error: "交易所数据暂时无法获取，且当前账户尚无成功缓存。",
    cache: syncCacheMetadata(record, "error", now, manualCooldownDuration),
  }, { status: 502, headers: privateResponseHeaders });
}

function updatedFallbackTime(value: string | undefined) {
  return value ?? new Date(0).toISOString();
}

function runPrivate<T>(platform: string, configured: boolean, task: () => Promise<T>): Promise<PrivateResult<T>> {
  if (!configured) return Promise.resolve({ snapshot: null, status: "not_configured" });
  return withSyncPlatform(platform, async () => {
    const startedAt = Date.now();
    try {
      return { snapshot: await task(), status: "synced" as const };
    } catch (error) {
      syncDiagnostic("platform_read_error", { errorKind: diagnosticErrorKind(error), durationMs: Date.now() - startedAt }, true);
      return { snapshot: null, status: "error" as const, diagnostic: safeDiagnostic(error) };
    }
  });
}

async function fetchBinanceAccountSnapshot(
  credentials: { apiKey: string; apiSecret: string },
  account: "global" | "bahrain",
): Promise<BinanceAccountSnapshot> {
  const [flexible, locked] = await Promise.allSettled([
    fetchBinanceFlexibleSnapshot(credentials, account),
    fetchBinanceLockedSnapshot(credentials, account),
  ]);
  const flexibleSnapshot = flexible.status === "fulfilled" ? flexible.value : null;
  const lockedSnapshot = locked.status === "fulfilled" ? locked.value : null;
  const apiStatuses: BinanceAccountSnapshot["apiStatuses"] = {
    flexibleProducts: flexibleSnapshot?.productApiStatus ?? "error",
    flexibleHoldings: flexibleSnapshot?.positionApiStatus ?? "error",
    fixedProducts: lockedSnapshot?.productApiStatus ?? "error",
    fixedHoldings: lockedSnapshot?.positionApiStatus ?? "error",
  };
  return {
    rates: [
      ...(flexibleSnapshot?.rates ?? []),
      ...(lockedSnapshot?.rates ?? []),
    ],
    holdings: {
      ...(flexibleSnapshot?.holdings ?? {}),
      ...(lockedSnapshot?.holdings ?? {}),
    },
    positions: lockedSnapshot?.positions ?? [],
    sync: {
      flexible: apiStatuses.flexibleProducts === "complete" && apiStatuses.flexibleHoldings === "complete",
      locked: apiStatuses.fixedProducts === "complete" && apiStatuses.fixedHoldings === "complete",
    },
    apiStatuses,
    lockedProductListComplete: lockedSnapshot?.productListComplete ?? false,
    lockedPositionListComplete: lockedSnapshot?.positionListComplete ?? false,
    productListsComplete: flexibleSnapshot?.productListsComplete ?? false,
    positionListsComplete: flexibleSnapshot?.positionListsComplete ?? false,
  };
}

function resolveBinanceStatus(snapshot: BinanceAccountSnapshot | null, fallback: PrivateStatus): PrivateStatus {
  if (!snapshot) return fallback;
  const statuses = Object.values(snapshot.apiStatuses);
  if (statuses.every((status) => status === "error")) return "error";
  if (statuses.every((status) => status === "complete")) return "synced";
  return "partial";
}

function combineApiReadStatuses(statuses: Array<"complete" | "partial" | "error">) {
  if (statuses.length > 0 && statuses.every((status) => status === "error")) return "error" as const;
  return statuses.length > 0 && statuses.every((status) => status === "complete") ? "complete" as const : "partial" as const;
}

function binanceScopes(snapshot: BinanceAccountSnapshot | null) {
  if (!snapshot) return undefined;
  const scopeLabels: Array<[keyof BinanceAccountSnapshot["apiStatuses"], string]> = [
    ["flexibleProducts", "活期产品"],
    ["flexibleHoldings", "活期持仓"],
    ["fixedProducts", "定期产品"],
    ["fixedHoldings", "定期持仓"],
  ];
  const scopes = scopeLabels.flatMap(([key, label]) => {
    const status = snapshot.apiStatuses[key];
    return status === "complete" ? [] : [`${label}${status === "error" ? "请求失败" : "部分返回"}`];
  });
  return scopes.length ? `scopes:${scopes.join("|")}` : undefined;
}

function normalizeLegacyNote(note: string) {
  const messages: string[] = [];
  const publicFailure = note.match(/([^。]*公共 APR[^。]*本次获取失败)/)?.[1];
  if (publicFailure) {
    const platforms = extractPlatforms(publicFailure);
    messages.push(`${platforms.join("、") || "公共"} API 获取失败`);
  }
  const privateFailure = note.match(/([^。]*本次私有同步失败)/)?.[1];
  if (privateFailure) messages.push(privateFailure.replace("本次私有同步失败", "账户 API 同步失败"));
  const partialFailure = note.match(/(Bitget 部分数据未返回(?:（[^）]*）)?)/)?.[1];
  if (partialFailure) messages.push(partialFailure);
  const fallbackTime = note.match(/未成功更新的项目沿用 ([^。]+?) 的最近一次成功数据/)?.[1];
  if (fallbackTime) messages.push(`沿用 ${fallbackTime} 缓存`);
  return messages.length ? `${messages.join("；")}。` : "";
}

function safeDiagnostic(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const responseCode = message.match(/\(([a-z0-9_\/;-]+)\)/i)?.[0];
  if (responseCode) return responseCode.slice(1, -1);
  if (error instanceof Error && error.name === "AbortError") return "timeout";
  return "unknown";
}

function safeCacheError(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") return "请求超时";
  return error instanceof Error ? error.message.slice(0, 180) : "未知错误";
}

function buildFailures(status: PrivateStatuses, diagnostics: PrivateDiagnostics, publicFailures: string[], publicPartials: string[] = []) {
  const failed = ([
    ["binanceGlobal", "Binance.com"],
    ["binanceBahrain", "Binance Bahrain"],
    ["bybitGlobal", "Bybit.com"],
    ["bitget", "Bitget"],
    ["okx", "OKX"],
  ] as const).flatMap(([key, label]) => status[key] === "error"
    ? [privateFailureLabel(key, label, diagnostics[key])]
    : []);
  const partialFailure = [
    ...(status.binanceGlobal === "partial" ? scopedBinanceFailures("Binance.com", diagnostics.binanceGlobal) : []),
    ...(status.binanceBahrain === "partial" ? scopedBinanceFailures("Binance Bahrain", diagnostics.binanceBahrain) : []),
    ...(status.bybitGlobal === "partial" ? scopedBybitFailures(diagnostics.bybitGlobal) : []),
    ...(status.bitget === "partial" ? scopedBitgetFailures(diagnostics.bitget) : []),
  ];
  const publicPlatforms = summarizePublicFailures(publicFailures);
  const partialPublicPlatforms = summarizePublicFailures(publicPartials).map((platform) => `${platform}（部分数据未返回）`);
  return [...failed, ...partialFailure, ...partialPublicPlatforms, ...publicPlatforms.filter((platform) => (
    !failed.some((failure) => platform.startsWith(failure.replace(/（.*$/, "")))
    && !partialFailure.some((failure) => platform.startsWith(failure.replace(/（.*$/, "")))
    && !partialPublicPlatforms.some((failure) => platform.startsWith(failure.replace(/（.*$/, "")))
  ))];
}

function buildNote(failures: string[]) {
  if (failures.length === 0) return "";
  const incomplete = failures.filter((failure) => failure.includes("未返回") || failure.includes("未完整返回"));
  const actualFailures = failures.filter((failure) => !failure.includes("未返回") && !failure.includes("未完整返回"));
  if (failures.some((failure) => failure === "公开交易所" || failure.includes("数据更新失败"))) {
    return "本次产品和持仓数据更新失败";
  }
  const incompleteText = incomplete.map((failure) => sanitizeSyncFailure(failure)).join("、");
  const actualTargets = [...new Set(actualFailures.map((failure) => failure.replace(/（.*$/, "").trim()).filter(Boolean))];
  const actualText = actualFailures.length
    ? (actualTargets.map((target) => `${target} API 暂不可用`).join("、") || "交易所 API 暂不可用")
    : "";
  return [
    incompleteText,
    actualText,
  ].filter(Boolean).length
    ? `${[incompleteText, actualText].filter(Boolean).join("；")}`
    : "";
}

function legacyFailures(note: string) {
  const messages: string[] = [];
  const privateFailure = note.match(/([^。]*)(?:本次私有同步失败|账户 API 同步失败)/)?.[1];
  if (privateFailure) messages.push(privateFailure.trim().replace(/[、，]$/, ""));
  const partialFailure = note.match(/Bitget 部分数据未返回(?:（([^）]*)）)?/)?.[1];
  if (partialFailure !== undefined) messages.push(`Bitget（${partialFailure || "部分数据未返回"}）`);
  const publicFailure = note.match(/([^。]*公共 (?:APR|API)[^。]*失败)/)?.[1];
  if (publicFailure) {
    const existing = messages.join("、");
    messages.push(...extractPlatforms(publicFailure).filter((platform) => !existing.includes(platform)));
  }
  return messages.length ? messages : extractPlatforms(note.match(/([^。]*失败[^。]*)/)?.[1] ?? "");
}

function extractPlatforms(text: string) {
  const knownPlatforms = ["Binance.com", "Binance Bahrain", "Bybit.com", "Bybit EU", "Bitget", "OKX", "MEXC"];
  return knownPlatforms.filter((platform) => text.includes(platform));
}

function privateFailureLabel(key: keyof PrivateStatuses, label: string, diagnostic?: string) {
  if (key === "bybitGlobal" && diagnostic?.startsWith("scopes:")) {
    const scopes = scopedBybitFailures(diagnostic);
    return scopes.length ? scopes.join("、") : label;
  }
  if ((key === "binanceGlobal" || key === "binanceBahrain") && diagnostic?.startsWith("scopes:")) {
    const scopes = scopedBinanceFailures(label, diagnostic);
    return scopes.length ? scopes.join("、") : label;
  }
  if (key === "bitget" && diagnostic?.startsWith("scopes:")) {
    const scopes = scopedBitgetFailures(diagnostic);
    return scopes.length ? scopes.join("、") : label;
  }
  if (key === "bitget" && diagnostic?.includes("public_blocked")) {
    return `${label}（账户与公开接口均访问失败，原因待检查）`;
  }
  if (key === "bitget" && diagnostic?.includes("public_ok")) {
    return `${label}（账户接口读取失败，公开接口可访问）`;
  }
  if (diagnostic === "timeout") return `${label}（请求超时）`;
  if (!diagnostic || diagnostic === "unknown") return `${label}（连接失败，原因待检查）`;
  return `${label}（接口返回 ${diagnostic}）`;
}

function scopedBybitFailures(diagnostic?: string) {
  const scopes = diagnostic?.startsWith("scopes:")
    ? diagnostic.slice("scopes:".length).split("|").filter(Boolean)
    : [];
  if (scopes.length === 0) return ["Bybit.com"];
  return scopes.map((scope) => {
    const flexibleFailure = scope.match(/^活期持仓请求失败:(.+)$/);
    if (flexibleFailure) return `Bybit.com 活期持仓 ${flexibleFailure[1]}`;
    if (scope.startsWith("活期持仓部分返回:")) return "Bybit.com 活期持仓部分数据未返回";
    if (scope.endsWith("请求失败")) return `Bybit.com ${scope.replace("请求失败", "")}`;
    if (scope.endsWith("部分返回")) return `Bybit.com ${scope.replace("部分返回", "部分数据未返回")}`;
    if (["定期产品", "定期持仓"].includes(scope)) return `Bybit.com ${scope}`;
    return `Bybit.com ${scope}`;
  });
}

function scopedBinanceFailures(label: string, diagnostic?: string) {
  const scopes = diagnostic?.startsWith("scopes:")
    ? diagnostic.slice("scopes:".length).split("|").filter(Boolean)
    : [];
  return scopes.length ? scopes.map((scope) => {
    if (scope.endsWith("请求失败")) return `${label} ${scope.replace("请求失败", "API 请求失败")}`;
    if (scope.endsWith("部分返回")) return `${label} ${scope.replace("部分返回", "部分数据未返回")}`;
    return `${label} ${scope}`;
  }) : [`${label} 部分数据未返回`];
}

function scopedBitgetFailures(diagnostic?: string) {
  const scopes = diagnostic?.startsWith("scopes:")
    ? diagnostic.slice("scopes:".length).split("|").filter(Boolean)
    : [];
  return scopes.length ? scopes.map((scope) => {
    if (scope.endsWith("请求失败")) return `Bitget ${scope.replace("请求失败", "")}`;
    if (scope.endsWith("部分返回")) return `Bitget ${scope.replace("部分返回", "部分数据未返回")}`;
    return `Bitget ${scope}`;
  }) : [diagnostic || "Bitget 部分数据未返回"];
}

function productHoldingSyncState(product: Product, statuses: PrivateStatuses): HoldingSyncState | null {
  if (product.holdingDataMode !== "api") return null;
  const statusByAccountId: Record<string, PrivateStatus> = {
    "binance-global": statuses.binanceGlobal,
    "binance-bahrain": statuses.binanceBahrain,
    "bybit-global": statuses.bybitGlobal,
    "bitget-global": statuses.bitget,
    "okx-global": statuses.okx,
  };
  return statusByAccountId[product.accountId] ?? "not_configured";
}
