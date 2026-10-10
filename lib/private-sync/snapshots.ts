import { fetchBinanceFlexibleSnapshot, fetchBinanceLockedSnapshot } from "@/lib/integrations/binance";
import { fetchBitgetFixedSnapshot, fetchBitgetSavingsSnapshot, type BitgetSavingsSnapshot } from "@/lib/integrations/bitget";
import { bybitGlobalApiBases, fetchBybitFlexibleHoldings, fetchBybitShortFixedSnapshots } from "@/lib/integrations/bybit";
import { fetchOkxSavingsHoldings } from "@/lib/integrations/okx";
import type { loadCredentials } from "@/lib/credentials";
import { fetchPublicRateSnapshot } from "@/lib/live-rates";
import { diagnosticErrorKind, syncDiagnostic, withSyncPlatform } from "@/lib/sync-diagnostics";
import { combineApiReadStatuses, safeDiagnostic } from "./status";
import type { BinanceAccountSnapshot, PrivateResult } from "./types";

/** Read all configured platform scopes concurrently; this layer never writes data. */
export async function fetchPrivateSnapshots(credentials: Awaited<ReturnType<typeof loadCredentials>>) {
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
  return { publicSnapshot, binanceGlobalResult, binanceBahrainResult, bybitGlobalResult, bitgetResult, okxResult };
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
