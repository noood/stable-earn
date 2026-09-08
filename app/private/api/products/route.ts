import type { D1Database } from "@cloudflare/workers-types";
import { NextResponse } from "next/server";
import { fetchBinanceFlexibleSnapshot, type BinanceFlexibleSnapshot } from "@/lib/integrations/binance";
import { fetchBitgetSavingsSnapshot, type BitgetSavingsSnapshot } from "@/lib/integrations/bitget";
import { bybitGlobalApiBases, fetchBybitFlexibleHoldings, fetchBybitShortFixedSnapshots } from "@/lib/integrations/bybit";
import { fetchOkxSavingsHoldings } from "@/lib/integrations/okx";
import { loadCredentials } from "@/lib/credentials";
import { getDatabase, getUserIdentity } from "@/lib/db";
import { fetchPublicRateSnapshot, summarizePublicFailures, type LiveRate } from "@/lib/live-rates";
import { privateResponseHeaders } from "@/lib/request-security";
import { mergeRates } from "@/lib/rate-cache";
import { loadManualRefreshCooldown, manualRefreshCooldownMs } from "@/lib/user-settings";
import { isLocalPreviewRequest, localPrivateProductsPreview, localSyncScenarioPreview } from "@/lib/local-preview";
import { cachedHoldingTimes } from "@/lib/holding-cache";
import { compareProductIdentity, type ProductIdentityChange } from "@/lib/product-identity";
import { prepareProductCatalogSync, resolveCatalogProductIds, type ProductCatalogSync } from "@/lib/product-catalog";
import type { HoldingSyncState, Product } from "@/lib/domain";
import { diagnosticErrorKind, syncDiagnostic, withSyncDiagnostics, withSyncPlatform } from "@/lib/sync-diagnostics";
import { acquireRefresh, claimDailyRefresh, refreshIsLocked, releaseRefresh, renewRefresh } from "@/lib/refresh-control";
import { scheduledRefreshPending } from "@/lib/sync-notice";
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
  const identity = await getUserIdentity(request);
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  if (isLocalPreviewRequest(request)) {
    const scenario = new URL(request.url).searchParams.get("syncScenario");
    if (scenario === "product-read-error" || scenario === "both-read-error") {
      return NextResponse.json({ error: "本地模拟：交易所缓存读取失败" }, { status: 503, headers: privateResponseHeaders });
    }
    const preview = localSyncScenarioPreview(scenario) ?? localPrivateProductsPreview();
    return NextResponse.json(preview, { status: scenario === "initial-error" ? 502 : 200, headers: privateResponseHeaders });
  }

  const db = await getDatabase();
  const params = new URL(request.url).searchParams;
  const manual = params.get("refresh") === "1";
  const daily = !manual && params.get("visit") === "1";
  const manualCooldownDuration = manualRefreshCooldownMs(await loadManualRefreshCooldown(db, identity.userId));
  let pending = false;
  async function reply(response: Response) {
    const body = await response.json() as Record<string, unknown>;
    return NextResponse.json({ ...body, dailyRefreshPending: daily && pending }, {
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
    if (scheduledRefreshPending(now, syncCacheMetadata(cached, syncAttemptInProgress(cached, now) ? "syncing" : "fresh", now))) {
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
    await db.batch([
      ...catalog.statements,
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

export async function listPrivateSyncUserIds(db: D1Database) {
  const result = await db.prepare(`SELECT user_id FROM exchange_credentials
      UNION SELECT user_id FROM holdings
      UNION SELECT user_id FROM user_products
      UNION SELECT owner_id AS user_id FROM sync_snapshots
      UNION SELECT owner_id AS user_id FROM product_catalog
      ORDER BY user_id`).all<{ user_id: string }>();
  return result.results.map((row) => row.user_id);
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
    () => fetchBinanceFlexibleSnapshot({
      apiKey: binanceGlobalCredential!.apiKey,
      apiSecret: binanceGlobalCredential!.apiSecret,
    }, "global"),
  );
  const binanceBahrainCredential = credentials["binance-bahrain"];
  const binanceBahrainJob = runPrivate(
    "binance-bahrain",
    Boolean(binanceBahrainCredential),
    () => fetchBinanceFlexibleSnapshot({
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
        ...flexible.sync.failedAssets,
        !fixed.sync.products ? "定期产品" : null,
        !fixed.sync.holdings ? "定期持仓" : null,
      ].filter((scope): scope is string => Boolean(scope));
      const successfulParts = flexible.sync.successfulAssets.length
        + Number(fixed.sync.products)
        + Number(fixed.sync.holdings);
      return {
        holdings: { ...flexible.holdings, ...fixed.holdings },
        rates: fixed.rates,
        failedScopes,
        successfulParts,
      };
    },
  );
  const bitgetCredential = credentials["bitget-global"];
  const bitgetJob = runPrivate(
    "bitget-global",
    Boolean(bitgetCredential?.passphrase),
    () => fetchBitgetSavingsSnapshot({
      apiKey: bitgetCredential!.apiKey,
      apiSecret: bitgetCredential!.apiSecret,
      passphrase: bitgetCredential!.passphrase!,
    }),
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
  const publicRates = publicSnapshot.rates;
  const publicFailures = publicSnapshot.failures;
  const binanceGlobal: BinanceFlexibleSnapshot | null = binanceGlobalResult.snapshot;
  const binanceBahrain: BinanceFlexibleSnapshot | null = binanceBahrainResult.snapshot;
  const bybitGlobal = bybitGlobalResult.snapshot;
  const bybitGlobalStatus: PrivateStatus = bybitGlobalResult.status !== "synced" || !bybitGlobal
    ? bybitGlobalResult.status
    : bybitGlobal.failedScopes.length === 0
      ? "synced"
      : bybitGlobal.successfulParts > 0
        ? "partial"
        : "error";
  const bybitGlobalDiagnostic = bybitGlobal?.failedScopes.length
    ? `scopes:${bybitGlobal.failedScopes.join("|")}`
    : bybitGlobalResult.diagnostic;
  const bitget: BitgetSavingsSnapshot | null = bitgetResult.snapshot;
  const bitgetStatus: PrivateStatus = bitgetResult.status !== "synced" || !bitget
    ? bitgetResult.status
    : bitget.sync.products && bitget.sync.holdings
      ? "synced"
      : bitget.sync.products || bitget.sync.holdings
        ? "partial"
        : "error";
  const bitgetDiagnostic = bitget && bitgetStatus === "partial"
    ? [
      !bitget.sync.products ? friendlyBitgetDiagnostic("产品", bitget.sync.productDiagnostic) : null,
      !bitget.sync.holdings ? friendlyBitgetDiagnostic("持仓", bitget.sync.holdingsDiagnostic) : null,
    ].filter(Boolean).join("；")
    : bitgetResult.diagnostic;
  const freshRates: LiveRate[] = [
    ...publicRates,
    ...(binanceGlobal?.rates ?? []),
    ...(binanceBahrain?.rates ?? []),
    ...(bybitGlobal?.rates ?? []),
    ...(bitget?.rates ?? []),
  ];
  const freshHoldingUpdates = {
    ...(binanceGlobal?.holdings ?? {}),
    ...(binanceBahrain?.holdings ?? {}),
    ...(bybitGlobal?.holdings ?? {}),
    ...(bitget?.holdings ?? {}),
    ...(okxResult.snapshot?.holdings ?? {}),
  };
  const fallbackRates = cached?.payload?.rates ?? [];
  const completeAccountIds = [
    binanceGlobalResult.status === "synced" ? "binance-global" : null,
    binanceBahrainResult.status === "synced" ? "binance-bahrain" : null,
    bybitGlobalStatus === "synced" ? "bybit-global" : null,
    // Bitget's sparse holding response does not prove zero for absent rows.
    // Keep explicit values (including 0), but do not infer an empty account.
    okxResult.status === "synced" ? "okx-global" : null,
  ].filter((accountId): accountId is string => Boolean(accountId));
  const catalog = await prepareProductCatalogSync(db, userId, freshRates, freshHoldingUpdates, completeAccountIds);
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
  const catalogProductIds = { ...await resolveCatalogProductIds(db, userId), ...catalog.productIds };
  const normalizedFreshHoldings: Record<string, number> = Object.fromEntries(Object.entries(freshHoldingUpdates)
    .map(([productId, amount]) => [catalogProductIds[productId] ?? productId, amount]));
  for (const product of catalog.products) {
    if (product.holdingDataMode === "api"
      && completeAccountIds.includes(product.accountId)
      && !Object.prototype.hasOwnProperty.call(normalizedFreshHoldings, product.id)) {
      normalizedFreshHoldings[product.id] = 0;
    }
  }
  const holdingUpdates = Object.fromEntries(Object.entries({
    ...(cached?.payload?.holdingUpdates ?? {}),
    ...normalizedFreshHoldings,
  }).map(([productId, amount]) => [catalogProductIds[productId] ?? productId, amount] as const)
    .filter(([productId]) => activeProductIds.has(productId)));
  const freshHoldingProductIds = new Set(Object.keys(normalizedFreshHoldings));
  const privateStatus: PrivateStatuses = {
    binanceGlobal: binanceGlobalResult.status,
    binanceBahrain: binanceBahrainResult.status,
    bybitGlobal: bybitGlobalStatus,
    bitget: bitgetStatus,
    okx: okxResult.status,
  };
  const holdingSyncStates = Object.fromEntries(catalog.products.flatMap((product) => {
    const state = productHoldingSyncState(product, privateStatus);
    return state ? [[product.id, state] as const] : [];
  }));
  const privateDiagnostics: PrivateDiagnostics = {
    binanceGlobal: binanceGlobalResult.diagnostic,
    binanceBahrain: binanceBahrainResult.diagnostic,
    bybitGlobal: bybitGlobalDiagnostic,
    bitget: bitgetDiagnostic,
    okx: okxResult.diagnostic,
  };
  const configuredError = Object.values(privateStatus).some((status) => status === "error" || status === "partial");
  const holdingFallbacks = Object.fromEntries(Object.entries(cachedHoldingTimes(
    cached?.payload?.holdingUpdates ?? {},
    cached?.payload?.holdingFallbacks ?? {},
    cached?.updatedAt ?? updatedFallbackTime(cached?.payload?.fetchedAt),
  ))
    .map(([productId, time]) => [catalogProductIds[productId] ?? productId, time])
    .filter(([productId]) => activeProductIds.has(productId) && !freshHoldingProductIds.has(productId)));
  const successfulPrivateJobs = Object.values(privateStatus).filter((status) => status === "synced" || status === "partial").length;
  // Log before the all-failed throw, which deliberately preserves the old cache.
  syncDiagnostic("sync_platforms", {
    ...privateStatus,
    publicOutcome: publicRates.length === 0 ? "no_usable_rates" : publicFailures.length ? "partial" : "success",
    ...(bitget ? { bitgetProducts: bitget.sync.products, bitgetHoldings: bitget.sync.holdings } : {}),
    ...(bybitGlobal ? { bybitFailedScopes: bybitGlobal.failedScopes.filter((scope) => ["USDT", "USDC", "定期产品", "定期持仓"].includes(scope)) } : {}),
  }, configuredError || publicFailures.length > 0);
  if (publicRates.length === 0 && successfulPrivateJobs === 0) {
    throw new Error("公开与账户接口均未返回可用数据");
  }

  const updatedAt = new Date().toISOString();
  const partial = publicFailures.length > 0 || configuredError;
  const failures = buildFailures(privateStatus, privateDiagnostics, publicFailures);
  const fallbackNote = partial && cached?.updatedAt
    ? `未成功更新的项目沿用 ${formatCacheTime(cached.updatedAt)} 的最近一次成功数据。`
    : "";
  return {
    catalog,
    retryable: configuredError,
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
      fetchedAt: updatedAt,
      partial,
      note: `${buildNote(failures)} ${fallbackNote}`.trim(),
      failures,
      fallbackUpdatedAt: failures.length > 0 ? cached?.updatedAt ?? null : null,
      identityChanges,
    },
  };
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
  const responseFailures = state === "syncing" ? [] : failed ? ["产品和持仓数据更新失败"] : failures;
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

function buildFailures(status: PrivateStatuses, diagnostics: PrivateDiagnostics, publicFailures: string[]) {
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
    ...(status.bybitGlobal === "partial" ? scopedBybitFailures(diagnostics.bybitGlobal) : []),
    ...(status.bitget === "partial" ? [`Bitget（${diagnostics.bitget || "部分数据未返回"}）`] : []),
  ];
  const publicPlatforms = summarizePublicFailures(publicFailures);
  return [...failed, ...partialFailure, ...publicPlatforms.filter((platform) => (
    !failed.some((failure) => platform.startsWith(failure.replace(/（.*$/, "")))
    && !partialFailure.some((failure) => platform.startsWith(failure.replace(/（.*$/, "")))
  ))];
}

function buildNote(failures: string[]) {
  return failures.length ? `${failures.join("、")} API 获取失败。` : "";
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
  if (key === "bybitGlobal" && diagnostic?.startsWith("scopes:")) return label;
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
  const assets = ["USDT", "USDC"].filter((asset) => scopes.includes(asset));
  const areas = scopes.filter((scope) => scope === "定期产品" || scope === "定期持仓");
  return [
    ...(assets.length > 0 ? [`Bybit.com ${assets.join("/")}`] : []),
    ...areas.map((area) => `Bybit.com ${area}`),
  ];
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

function friendlyBitgetDiagnostic(area: "产品" | "持仓", diagnostic?: string) {
  if (diagnostic?.startsWith("missing_")) {
    return `${diagnostic.slice("missing_".length).replaceAll("_", "、")} 产品未返回`;
  }
  if (diagnostic === "timeout") return `${area}接口请求超时`;
  if (diagnostic?.startsWith("401/") || diagnostic?.startsWith("403/")) return `${area}接口拒绝访问`;
  return `${area}接口未完整返回`;
}
