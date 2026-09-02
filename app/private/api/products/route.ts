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
import { isLocalPreviewRequest, localPrivateProductsPreview } from "@/lib/local-preview";
import { filterFallbacksByFailures } from "@/lib/sync-fallback";
import { compareProductIdentity, type ProductIdentityChange } from "@/lib/product-identity";
import { resolveCatalogProductIds, syncProductCatalog } from "@/lib/product-catalog";
import type { HoldingSyncState, Product } from "@/lib/domain";
import {
  formatCacheTime,
  loadSyncCache,
  manualCooldownUntil,
  recordSyncAttempt,
  recordSyncFailure,
  saveSyncCache,
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

const privateCacheKey = "private-products";

export async function GET(request: Request) {
  const identity = await getUserIdentity(request);
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  if (isLocalPreviewRequest(request)) {
    return NextResponse.json(localPrivateProductsPreview(), { headers: privateResponseHeaders });
  }

  const db = await getDatabase();
  const manual = new URL(request.url).searchParams.get("refresh") === "1";
  const now = Date.now();
  const [cached, manualCooldownMinutes] = await Promise.all([
    loadSyncCache<PrivateProductsPayload>(db, identity.userId, privateCacheKey),
    loadManualRefreshCooldown(db, identity.userId),
  ]);
  const manualCooldownDuration = manualRefreshCooldownMs(manualCooldownMinutes);

  if (!manual) {
    if (cached?.payload) return cachedResponse(cached, cached.lastError ? "error" : "fresh", "按每日 08:00、20:00 的计划缓存读取，未请求交易所。", now, manualCooldownDuration);
    return NextResponse.json({
      products: [],
      rates: [],
      rateFallbacks: {},
      holdingUpdates: {},
      holdingSourceIds: [],
      holdingFallbacks: {},
      partial: false,
      note: "等待下一次计划更新；可使用右上角手动刷新。",
      failures: [],
      cache: syncCacheMetadata(cached, "stale", now, manualCooldownDuration),
    }, { headers: privateResponseHeaders });
  }

  const cooldownUntil = manualCooldownUntil(cached, now, manualCooldownDuration);
  if (manual && cooldownUntil) {
    if (cached?.payload) return cachedResponse(cached, "cooldown", `手动刷新冷却中，可在 ${formatCacheTime(cooldownUntil)} 后重试。`, now, manualCooldownDuration);
    return NextResponse.json({ error: `手动刷新冷却中，可在 ${formatCacheTime(cooldownUntil)} 后重试。` }, { status: 429, headers: privateResponseHeaders });
  }

  try {
    const saved = await refreshPrivateProductsCache(db, identity.userId, true);
    return cachedResponse(saved, "updated", "已完成手动刷新。", now, manualCooldownDuration);
  } catch {
    const failedCache = await loadSyncCache<PrivateProductsPayload>(db, identity.userId, privateCacheKey);
    if (failedCache?.payload) {
      return cachedResponse(failedCache, "error", `更新暂时失败，继续显示 ${formatCacheTime(failedCache.updatedAt)} 的最近一次成功数据。`, now, manualCooldownDuration);
    }
    return NextResponse.json({ error: "交易所数据暂时无法获取，且当前账户尚无成功缓存。" }, {
      status: 502,
      headers: privateResponseHeaders,
    });
  }
}

export async function refreshPrivateProductsCache(db: D1Database, userId: string, manual = false) {
  const cached = await loadSyncCache<PrivateProductsPayload>(db, userId, privateCacheKey);
  await recordSyncAttempt(db, userId, privateCacheKey, manual);
  try {
    const payload = await buildPrivatePayload(db, userId, cached);
    await saveSyncCache(db, userId, privateCacheKey, payload, payload.fetchedAt);
    return (await loadSyncCache<PrivateProductsPayload>(db, userId, privateCacheKey))!;
  } catch (error) {
    await recordSyncFailure(db, userId, privateCacheKey, safeCacheError(error));
    throw error;
  }
}

export async function listPrivateSyncUserIds(db: D1Database) {
  const result = await db.prepare(`SELECT user_id FROM exchange_credentials
      UNION SELECT user_id FROM holdings
      UNION SELECT user_id FROM user_products
      ORDER BY user_id`).all<{ user_id: string }>();
  return result.results.map((row) => row.user_id);
}

async function buildPrivatePayload(
  db: D1Database,
  userId: string,
  cached: SyncCacheRecord<PrivateProductsPayload> | null,
): Promise<PrivateProductsPayload> {
  const credentials = await loadCredentials(db, userId);
  const publicSnapshotPromise = fetchPublicRateSnapshot();
  const binanceGlobalCredential = credentials["binance-global"];
  const binanceGlobalJob = runPrivate(
    Boolean(binanceGlobalCredential),
    () => fetchBinanceFlexibleSnapshot({
      apiKey: binanceGlobalCredential!.apiKey,
      apiSecret: binanceGlobalCredential!.apiSecret,
    }, "global"),
  );
  const binanceBahrainCredential = credentials["binance-bahrain"];
  const binanceBahrainJob = runPrivate(
    Boolean(binanceBahrainCredential),
    () => fetchBinanceFlexibleSnapshot({
      apiKey: binanceBahrainCredential!.apiKey,
      apiSecret: binanceBahrainCredential!.apiSecret,
    }, "bahrain"),
  );
  const bybitGlobalCredential = credentials["bybit-global"];
  const bybitGlobalJob = runPrivate(
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
      return { holdings: { ...flexible.holdings, ...fixed.holdings }, rates: fixed.rates };
    },
  );
  const bitgetCredential = credentials["bitget-global"];
  const bitgetJob = runPrivate(
    Boolean(bitgetCredential?.passphrase),
    () => fetchBitgetSavingsSnapshot({
      apiKey: bitgetCredential!.apiKey,
      apiSecret: bitgetCredential!.apiSecret,
      passphrase: bitgetCredential!.passphrase!,
    }),
  );
  const okxCredential = credentials["okx-global"];
  const okxJob = runPrivate(
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
    ...(bybitGlobalResult.snapshot?.rates ?? []),
    ...(bitget?.rates ?? []),
  ];
  const freshHoldingUpdates = {
    ...(binanceGlobal?.holdings ?? {}),
    ...(binanceBahrain?.holdings ?? {}),
    ...(bybitGlobalResult.snapshot?.holdings ?? {}),
    ...(bitget?.holdings ?? {}),
    ...(okxResult.snapshot?.holdings ?? {}),
  };
  const fallbackRates = cached?.payload?.rates ?? [];
  const catalog = await syncProductCatalog(db, userId, freshRates, Object.keys(freshHoldingUpdates));
  const rates = mergeRates(catalog.rates, fallbackRates);
  const previousRates = new Map((cached?.payload?.rates ?? []).map((rate) => [rate.productId, rate]));
  const identityChanges = Object.fromEntries(catalog.rates.map((rate) => [
    rate.productId,
    compareProductIdentity(previousRates.get(rate.productId), rate),
  ]));
  const freshRateProductIds = new Set(catalog.rates.map((rate) => rate.productId));
  const rateFallbacks = Object.fromEntries(rates
    .filter((rate) => !freshRateProductIds.has(rate.productId))
    .map((rate) => [rate.productId, rate.fetchedAt]));
  const catalogProductIds = { ...await resolveCatalogProductIds(db, userId), ...catalog.productIds };
  const holdingUpdates = Object.fromEntries(Object.entries({
    ...(cached?.payload?.holdingUpdates ?? {}),
    ...freshHoldingUpdates,
  }).map(([productId, amount]) => [catalogProductIds[productId] ?? productId, amount]));
  const freshHoldingProductIds = new Set(Object.keys(freshHoldingUpdates).map((productId) => catalogProductIds[productId] ?? productId));
  const privateStatus: PrivateStatuses = {
    binanceGlobal: binanceGlobalResult.status,
    binanceBahrain: binanceBahrainResult.status,
    bybitGlobal: bybitGlobalResult.status,
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
    bybitGlobal: bybitGlobalResult.diagnostic,
    bitget: bitgetDiagnostic,
    okx: okxResult.diagnostic,
  };
  const configuredError = Object.values(privateStatus).some((status) => status === "error" || status === "partial");
  const holdingFallbacks = Object.fromEntries(Object.keys(cached?.payload?.holdingUpdates ?? {})
    .map((productId) => catalogProductIds[productId] ?? productId)
    .filter((productId) => !freshHoldingProductIds.has(productId))
    .map((productId) => [productId, cached?.updatedAt ?? updatedFallbackTime(cached?.payload?.fetchedAt)]));
  const successfulPrivateJobs = Object.values(privateStatus).filter((status) => status === "synced" || status === "partial").length;
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
    products: catalog.products,
    rates,
    rateFallbacks,
    holdingUpdates,
    holdingSourceIds: [...new Set([
      ...(cached?.payload?.holdingSourceIds ?? []),
      ...Object.keys(freshHoldingUpdates).map((productId) => catalogProductIds[productId] ?? productId),
    ])],
    holdingFallbacks,
    holdingSyncStates,
    fetchedAt: updatedAt,
    partial,
    note: `${buildNote(failures)} ${fallbackNote}`.trim(),
    failures,
    fallbackUpdatedAt: failures.length > 0 ? cached?.updatedAt ?? null : null,
    identityChanges,
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
  const responseFailures = state === "error"
    ? ["产品和持仓数据更新失败"]
    : failures;
  return NextResponse.json({
    ...payload,
    rateFallbacks: state === "error"
      ? Object.fromEntries(payload.rates.map((rate) => [rate.productId, rate.fetchedAt || record.updatedAt]))
      : payload.partial ? filterFallbacksByFailures(payload.rateFallbacks ?? {}, failures) : {},
    holdingFallbacks: state === "error"
      ? Object.fromEntries(Object.keys(payload.holdingUpdates).map((productId) => [productId, record.updatedAt]))
      : payload.partial ? filterFallbacksByFailures(payload.holdingFallbacks ?? {}, failures) : {},
    fetchedAt: record.updatedAt ?? payload.fetchedAt,
    cache: syncCacheMetadata(record, state, now, manualCooldownDuration),
    note: `${statusText} ${normalizeLegacyNote(payload.note)}`.trim(),
    failures: responseFailures,
    fallbackUpdatedAt: payload.fallbackUpdatedAt
      ?? legacyFallbackTime(payload.note)
      ?? (state === "error" ? record.updatedAt : null),
  }, { headers: privateResponseHeaders });
}

function updatedFallbackTime(value: string | undefined) {
  return value ?? new Date(0).toISOString();
}

function runPrivate<T>(configured: boolean, task: () => Promise<T>): Promise<PrivateResult<T>> {
  if (!configured) return Promise.resolve({ snapshot: null, status: "not_configured" });
  return task()
    .then((snapshot) => ({ snapshot, status: "synced" as const }))
    .catch((error: unknown) => ({
      snapshot: null,
      status: "error" as const,
      diagnostic: safeDiagnostic(error),
    }));
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
  const partialFailure = status.bitget === "partial"
    ? [`Bitget（${diagnostics.bitget || "部分数据未返回"}）`]
    : [];
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

function legacyFallbackTime(note: string) {
  return note.match(/未成功更新的项目沿用 ([^。]+?) 的最近一次成功数据/)?.[1] ?? null;
}

function extractPlatforms(text: string) {
  const knownPlatforms = ["Binance.com", "Binance Bahrain", "Bybit.com", "Bybit EU", "Bitget", "OKX", "MEXC"];
  return knownPlatforms.filter((platform) => text.includes(platform));
}

function privateFailureLabel(key: keyof PrivateStatuses, label: string, diagnostic?: string) {
  if (key === "bitget" && diagnostic?.includes("public_blocked")) {
    return `${label}（官方 API 暂时拒绝本站服务器访问）`;
  }
  if (key === "bitget" && diagnostic?.includes("public_ok")) {
    return `${label}（API Key、Passphrase 或权限被拒绝）`;
  }
  if (diagnostic === "timeout") return `${label}（请求超时）`;
  if (!diagnostic || diagnostic === "unknown") return `${label}（连接失败，原因待检查）`;
  return `${label}（接口返回 ${diagnostic}）`;
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
