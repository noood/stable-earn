import type { D1Database } from "@cloudflare/workers-types";
import { loadCredentials } from "@/lib/credentials";
import type { ApiFieldNotice, LiveRate } from "@/lib/live-rates";
import type { BitgetSavingsSnapshot } from "@/lib/integrations/bitget";
import { mergeRateFields, mergeRates } from "@/lib/rate-cache";
import { cachedHoldingTimes, mergeHoldingPositions } from "@/lib/holding-cache";
import { compareProductIdentity } from "@/lib/product-identity";
import { prepareProductCatalogSync, resolveCatalogProductAccounts, resolveCatalogProductIds } from "@/lib/product-catalog";
import type { HoldingPosition } from "@/lib/domain";
import { authoritativeEmptyHoldingScopeKeys, platformCapabilityScopeKey } from "@/lib/platform-capabilities";
import { syncDiagnostic } from "@/lib/sync-diagnostics";
import { formatCacheTime, type SyncCacheRecord } from "@/lib/sync-cache";
import type { BinanceAccountSnapshot, PrivateDiagnostics, PrivatePayloadBuild, PrivateProductsPayload, PrivateStatus, PrivateStatuses } from "./types";
import { binanceScopes, buildFailures, buildNote, productHoldingSyncState, resolveBinanceStatus } from "./status";
import { fetchPrivateSnapshots } from "./snapshots";

/** Build a candidate and prepared statements without committing any changes. */
export async function buildPrivatePayload(
  db: D1Database,
  userId: string,
  cached: SyncCacheRecord<PrivateProductsPayload> | null,
): Promise<PrivatePayloadBuild> {
  const credentials = await loadCredentials(db, userId);
  const { publicSnapshot, binanceGlobalResult, binanceBahrainResult, bybitGlobalResult, bitgetResult, okxResult } = await fetchPrivateSnapshots(credentials);
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
  const adapterRates: LiveRate[] = [
    ...publicRates,
    ...(binanceGlobal?.rates ?? []),
    ...(binanceBahrain?.rates ?? []),
    ...(bybitGlobal?.rates ?? []),
    ...(bitget?.rates ?? []),
  ];
  const fallbackRates = cached?.payload?.rates ?? [];
  const freshRates = mergeRateFields(adapterRates, fallbackRates);
  const apiFieldNotices: ApiFieldNotice[] = [
    ...(publicSnapshot.fieldNotices ?? []).flatMap((notice) => {
      const rate = freshRates.find((candidate) => candidate.catalog?.accountId === notice.accountId
        && candidate.catalog.asset === notice.asset
        && (notice.externalProductId
          ? candidate.externalProductId === notice.externalProductId
          : candidate.name === notice.productName));
      if (!rate) return [notice];
      const fields = notice.fields.filter((field) => {
        if ((field.includes("APR") || field.includes("阶梯结构")) && rate.aprSource === "cache") return false;
        if (field.includes("额度") && rate.capacitySource === "cache") return false;
        return true;
      });
      return fields.length ? [{ ...notice, fields }] : [];
    }),
    ...freshRates.flatMap((rate) => {
      if (rate.productDataMode === "manual" || !rate.catalog) return [];
      const fields = rate.rateCoverage === "unavailable"
        ? ["APR 未获取"]
        : rate.rateCoverage === "partial" ? ["阶梯结构未获取"]
          : rate.rateCoverage === "base_only" ? ["首档额度未获取"]
            : rate.tiers?.some((tier) => tier.max === null && tier.maxStatus !== "unlimited")
              ? ["首档额度未获取"]
              : [];
      return fields.length ? [{
        accountId: rate.catalog.accountId,
        asset: rate.catalog.asset,
        productName: rate.name ?? rate.externalProductId ?? rate.productId,
        externalProductId: rate.externalProductId,
        fields,
      }] : [];
    }),
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

function updatedFallbackTime(value: string | undefined) {
  return value ?? new Date(0).toISOString();
}
