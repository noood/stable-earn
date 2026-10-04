import { fetchBinanceFlexibleSnapshot, fetchBinanceLockedSnapshot } from "@/lib/integrations/binance";
import { probeBitgetAssets } from "@/lib/integrations/bitget";
import { bybitGlobalApiBases, fetchBybitFlexibleHoldings, scanBybitFixedHoldings, scanBybitFixedProducts, scanBybitFlexibleProducts } from "@/lib/integrations/bybit";
import { fetchOkxOnchainOffers, fetchOkxSavingsHoldings } from "@/lib/integrations/okx";
import type { LiveRate } from "@/lib/live-rates";
import { apiAssetsFor, availableApiAssetsFor, capabilityApiReference, monitoredAssets, platformCapabilities, type CapabilityProductType, type PlatformApiMode } from "@/lib/platform-capabilities";
import { collectSyncDiagnostics, withSyncPlatform } from "@/lib/sync-diagnostics";

type ProbeCredential = { apiKey: string; apiSecret: string; passphrase?: string };
type ProbeStatus = "unsupported" | "not_configured" | "not_checked" | "returned" | "empty" | "checked" | "partial" | "error";
type RateShape = "single_rate" | "tiered_rate" | "no_rate";
type SafeApiRow = {
  id: string | null;
  status?: string;
  productLevel?: string;
  periodType?: string;
  period?: string;
  duration?: string;
  tierCount?: number;
  rateShape?: RateShape;
  eligibleForMonitoring?: boolean;
  isVip?: boolean;
  specialUserGroupRequired?: boolean;
  asset?: string;
  protocol?: string;
  protocolType?: string;
  term?: string;
};
type ApiProbe = {
  mode: PlatformApiMode;
  dailySyncEnabled: boolean;
  status: ProbeStatus;
  statusLabel: string;
  rowCount: number | null;
  ids: string[];
  rows: SafeApiRow[];
  rateSummary?: { singleRateRows: number; tieredRateRows: number; noRateRows: number; unknownRateRows: number };
  complete: boolean | null;
  checkedAt: string | null;
  note?: string;
};
type CapabilityScope = {
  accountId: string;
  asset: string;
  productType: CapabilityProductType;
  productApi: ApiProbe;
  holdingApi: ApiProbe;
};
type SupplementalAssetProbe = {
  asset: string;
  status: ProbeStatus;
  rowCount: number | null;
  rows: SafeApiRow[];
  complete?: boolean | null;
  note?: string;
};
type SupplementalProbe = {
  accountId: string;
  id: "okx-onchain-earn-offers";
  category: "onchain_earn";
  endpoint: "/api/v5/finance/staking-defi/offers";
  mode: "authenticated";
  note: string;
  assets: SupplementalAssetProbe[];
};

const reportIdLimit = 40;

/**
 * One-off read-only API scan. It calls only known endpoints already used by
 * the application or the Bitget capability probe; it never commits products,
 * holdings, cache entries, or history.
 */
export async function probePlatformCapabilities(credentials: Partial<Record<string, ProbeCredential>>) {
  const credentialReady = (accountId: string) => {
    const credential = credentials[accountId];
    if (!credential?.apiKey || !credential.apiSecret) return false;
    return !["bitget-global", "okx-global"].includes(accountId) || Boolean(credential.passphrase);
  };
  const scopes: CapabilityScope[] = platformCapabilities.map((capability) => ({
    accountId: capability.accountId,
    asset: capability.asset,
    productType: capability.productType,
    productApi: initialApi(capability.productApi, capability.productDailySync, credentialReady(capability.accountId)),
    holdingApi: initialApi(capability.holdingApi, capability.holdingDailySync, credentialReady(capability.accountId)),
  }));
  const okxCredentialReady = credentialReady("okx-global");
  const supplementalProbes: SupplementalProbe[] = [{
    accountId: "okx-global",
    id: "okx-onchain-earn-offers",
    category: "onchain_earn",
    endpoint: "/api/v5/finance/staking-defi/offers",
    mode: "authenticated",
    note: "单次独立检查 OKX On-chain Earn 并按四币整理；不代表普通活期/定期 Savings 产品能力，也不会启用常规同步。",
    assets: monitoredAssets.map((asset) => ({
      asset,
      status: okxCredentialReady ? "not_checked" : "not_configured",
      rowCount: null,
      rows: [],
      ...(!okxCredentialReady ? { note: "未配置 OKX API 凭证，本次未请求。" } : {}),
    })),
  }];

  const findScope = (accountId: string, asset: string, productType: CapabilityProductType) => scopes.find((scope) => (
    scope.accountId === accountId && scope.asset === asset && scope.productType === productType
  ));
  const setResult = (
    accountId: string,
    asset: string,
    productType: CapabilityProductType,
    field: "productApi" | "holdingApi",
    result: { status: ProbeStatus; ids?: string[]; rows?: SafeApiRow[]; rowCount?: number; complete?: boolean; note?: string },
  ) => {
    const scope = findScope(accountId, asset, productType);
    if (!scope) return;
    if (scope[field].mode === "unsupported") return;
    const isPrivateHolding = field === "holdingApi";
    const status = isPrivateHolding && (result.status === "returned" || result.status === "empty") ? "checked" : result.status;
    const allRows = isPrivateHolding ? [] : result.rows
      ? mergeSafeApiRows(scope[field].rows, result.rows)
      : (result.ids ?? []).map((id) => ({ id }));
    const rows = allRows.slice(0, reportIdLimit);
    scope[field] = {
      ...scope[field],
      status,
      statusLabel: isPrivateHolding ? holdingStatusLabel(status) : statusLabel(status, result.rowCount ?? result.ids?.length ?? 0),
      rowCount: isPrivateHolding ? null : result.rowCount ?? result.ids?.length ?? 0,
      ids: isPrivateHolding ? [] : limitedUnique(result.ids ?? []),
      rows,
      ...(!isPrivateHolding ? { rateSummary: summarizeRateShapes(allRows) } : {}),
      complete: result.complete ?? (status === "returned" || status === "empty" || status === "checked"),
      checkedAt: new Date().toISOString(),
      ...(result.note ? { note: result.note } : {}),
    };
  };
  const setError = (accountId: string, asset: string, productType: CapabilityProductType, fields: Array<"productApi" | "holdingApi">) => {
    for (const field of fields) setResult(accountId, asset, productType, field, { status: "error", complete: false });
  };

  const { captured } = await collectSyncDiagnostics(async () => {
    const jobs: Promise<void>[] = [];

    // Probe every monitored coin through the public Bybit endpoint without
    // expanding routine daily sync coverage or enabling unknown API scopes.
    for (const accountId of ["bybit-global", "bybit-eu"] as const) {
      for (const asset of availableApiAssetsFor(accountId, "flexible", "productApi")) {
        jobs.push((async () => {
          try {
            const scan = await scanBybitFlexibleProducts(accountId, asset);
            const rows = scan.rows;
            const configuredCapability = platformCapabilities.find((entry) => (
              entry.accountId === accountId && entry.asset === asset && entry.productType === "flexible"
            ));
            setResult(accountId, asset, "flexible", "productApi", {
              status: !scan.complete ? "partial" : rows.length ? "returned" : "empty",
              ids: rows.map((row) => row.productId).filter((id): id is string => Boolean(id)),
              rows: rows.map((row) => ({
                id: row.productId,
                ...(row.status ? { status: row.status } : {}),
                ...(row.tierCount !== undefined ? { tierCount: row.tierCount } : {}),
                rateShape: row.rateShape ?? (row.tiers?.length ? "tiered_rate" : row.apr !== undefined || row.apy !== undefined ? "single_rate" : "no_rate"),
              })),
              rowCount: scan.rowCount,
              complete: scan.complete,
              ...(!configuredCapability?.productDailySync ? { note: "本次通过公开接口只读检查；常规同步尚未接入此范围。" } : {}),
            });
          } catch {
            setResult(accountId, asset, "flexible", "productApi", { status: "error", complete: false });
          }
        })());
      }
    }

    for (const accountId of ["bybit-global", "bybit-eu"] as const) {
      jobs.push((async () => {
        try {
          const scan = await scanBybitFixedProducts(accountId);
          const rows = scan.rows;
          for (const asset of availableApiAssetsFor(accountId, "fixed", "productApi")) {
            const assetRows = rows.filter((row) => row.coin === asset);
            setResult(accountId, asset, "fixed", "productApi", {
              status: !scan.complete ? "partial" : assetRows.length ? "returned" : "empty",
              ids: assetRows.map((row) => row.externalProductId),
              rows: assetRows.map((row) => ({
                id: row.externalProductId,
                status: row.status ?? undefined,
                duration: row.duration,
                tierCount: row.tierCount,
                rateShape: row.rateShape ?? (row.tierCount > 0 ? "tiered_rate" : row.apy !== undefined ? "single_rate" : "no_rate"),
                isVip: row.isVip,
                specialUserGroupRequired: row.specialUserGroupRequired,
              })),
              rowCount: assetRows.length,
              complete: scan.complete,
              ...(!platformCapabilities.find((entry) => entry.accountId === accountId && entry.asset === asset && entry.productType === "fixed")?.productDailySync
                ? { note: "本次通过公开接口只读检查；常规同步尚未接入此范围。" }
                : {}),
            });
          }
        } catch {
          for (const asset of availableApiAssetsFor(accountId, "fixed", "productApi")) {
            setResult(accountId, asset, "fixed", "productApi", { status: "error", complete: false });
          }
        }
      })());
    }

    for (const [accountId, region] of [["binance-global", "global"], ["binance-bahrain", "bahrain"]] as const) {
      const credential = credentials[accountId];
      if (!credentialReady(accountId)) continue;
      const binanceCredential = { apiKey: credential!.apiKey, apiSecret: credential!.apiSecret };
      for (const asset of monitoredAssets) {
        jobs.push(withSyncPlatform(accountId, async () => {
          try {
            const result = await fetchBinanceFlexibleSnapshot(binanceCredential, region, [asset]);
            const rates = result.rates.filter((rate) => rate.catalog?.asset === asset);
            const positiveHoldingIds = Object.entries(result.holdings)
              .filter(([, amount]) => amount > 0)
              .map(([identity]) => externalIdFromScoped(identity));
            setResult(accountId, asset, "flexible", "productApi", {
              status: result.productApiStatus === "error" ? "error"
                : result.productApiStatus === "partial" ? "partial"
                  : rates.length ? "returned" : "empty",
              ids: rates.map((rate) => rate.externalProductId).filter((id): id is string => Boolean(id)),
              rows: rates.map((rate) => safeLiveRateRow(rate)),
              rowCount: rates.length,
              complete: result.productListsComplete,
              ...(!apiAssetsFor(accountId, "flexible", "productApi").includes(asset)
                ? { note: "本次通过现有账户接口只读检查；常规同步尚未接入此资产。" }
                : {}),
            });
            setResult(accountId, asset, "flexible", "holdingApi", {
              status: result.positionApiStatus === "error" ? "error"
                : result.positionApiStatus === "partial" ? "partial"
                  : positiveHoldingIds.length ? "returned" : "empty",
              ids: positiveHoldingIds,
              rowCount: positiveHoldingIds.length,
              complete: result.positionListsComplete,
              ...(!apiAssetsFor(accountId, "flexible", "holdingApi").includes(asset)
                ? { note: "本次通过现有账户接口只读检查；常规同步尚未接入此资产。" }
                : {}),
            });
          } catch {
            setError(accountId, asset, "flexible", ["productApi", "holdingApi"]);
          }
        }));
      }
      jobs.push(withSyncPlatform(accountId, async () => {
        try {
          const result = await fetchBinanceLockedSnapshot(binanceCredential, region, monitoredAssets);
          for (const asset of monitoredAssets) {
            const rates = result.rates.filter((rate) => rate.catalog?.asset === asset);
            const positions = result.positions.filter((position) => position.asset === asset);
            setResult(accountId, asset, "fixed", "productApi", {
              status: result.productApiStatus === "error" ? "error"
                : result.productApiStatus === "partial" ? "partial"
                  : rates.length ? "returned" : "empty",
              ids: rates.map((rate) => rate.externalProductId).filter((id): id is string => Boolean(id)),
              rows: rates.map((rate) => safeLiveRateRow(rate)),
              rowCount: rates.length,
              complete: result.productListComplete,
            });
            setResult(accountId, asset, "fixed", "holdingApi", {
              status: result.positionApiStatus === "error" ? "error"
                : result.positionApiStatus === "partial" ? "partial"
                  : positions.length ? "returned" : "empty",
              ids: positions.map((position) => externalIdFromScoped(position.sourceProductId)),
              rowCount: positions.length,
              complete: result.positionListComplete,
            });
          }
        } catch {
          for (const asset of monitoredAssets) setError(accountId, asset, "fixed", ["productApi", "holdingApi"]);
        }
      }));
    }

    const bybitCredential = credentials["bybit-global"];
    if (credentialReady("bybit-global")) {
      const bybit = { apiKey: bybitCredential!.apiKey, apiSecret: bybitCredential!.apiSecret, baseUrls: bybitGlobalApiBases };
      jobs.push(withSyncPlatform("bybit-global", async () => {
        try {
          const holdingAssets = availableApiAssetsFor("bybit-global", "flexible", "holdingApi");
          const result = await fetchBybitFlexibleHoldings(bybit, "global", holdingAssets);
          for (const asset of holdingAssets) {
            const failed = result.sync.failedAssets.includes(asset);
            const partial = result.sync.partialAssets.includes(asset);
            const ids = Object.keys(result.holdings)
              .filter((identity) => identity.includes(`:${asset}:flexible:`))
              .map((identity) => externalIdFromScoped(identity));
            setResult("bybit-global", asset, "flexible", "holdingApi", {
              status: failed ? "error" : partial ? "partial" : ids.length ? "returned" : "empty",
              ids,
              rowCount: ids.length,
              complete: !failed && !partial,
              ...(!apiAssetsFor("bybit-global", "flexible", "holdingApi").includes(asset)
                ? { note: "本次通过现有账户接口只读检查；常规同步尚未接入此资产。" }
                : {}),
            });
          }
        } catch {
          for (const asset of availableApiAssetsFor("bybit-global", "flexible", "holdingApi")) setResult("bybit-global", asset, "flexible", "holdingApi", { status: "error", complete: false });
        }
      }));
      jobs.push(withSyncPlatform("bybit-global", async () => {
        try {
          const scan = await scanBybitFixedHoldings(bybit);
          const rows = scan.rows;
          for (const asset of availableApiAssetsFor("bybit-global", "fixed", "holdingApi")) {
            const assetRows = rows.filter((row) => row.coin === asset);
            const identityIncomplete = !scan.complete || assetRows.some((row) => !row.productId || !row.duration);
            const outputRows = assetRows.map((row) => ({
              id: bybitFixedIdentityId(row.productId, row.duration),
              ...(row.duration ? { duration: row.duration } : {}),
              ...(row.status ? { status: row.status } : {}),
              hasPositiveHolding: row.hasPositiveHolding,
            }));
            setResult("bybit-global", asset, "fixed", "holdingApi", {
              status: identityIncomplete ? "partial" : assetRows.length ? "returned" : "empty",
              ids: outputRows.map((row) => row.id).filter((id): id is string => Boolean(id)),
              rows: outputRows,
              rowCount: assetRows.length,
              complete: !identityIncomplete,
            });
          }
        } catch {
          for (const asset of availableApiAssetsFor("bybit-global", "fixed", "holdingApi")) {
            setResult("bybit-global", asset, "fixed", "holdingApi", { status: "error", complete: false });
          }
        }
      }));
    }

    const bitgetCredential = credentials["bitget-global"];
    if (credentialReady("bitget-global")) {
      jobs.push(withSyncPlatform("bitget-global", async () => {
        const results = await probeBitgetAssets({
          apiKey: bitgetCredential!.apiKey,
          apiSecret: bitgetCredential!.apiSecret,
          passphrase: bitgetCredential!.passphrase!,
        }, monitoredAssets);
        for (const result of results) {
          const asset = result.asset;
          for (const productType of ["flexible", "fixed"] as const) {
            const productRows = result.productApi.rows.filter((row) => row.periodType === productType);
            const productCapability = platformCapabilities.find((item) => item.accountId === "bitget-global" && item.asset === asset && item.productType === productType);
            setResult("bitget-global", asset, productType, "productApi", {
              status: result.productApi.status === "error" ? "error"
                : result.productApi.status === "partial" ? "partial"
                  : productRows.length ? "returned" : "empty",
              ids: productRows.map((row) => row.productId).filter((id): id is string => Boolean(id)),
              rows: sanitizeApiRows(productRows, "productId", false, "apy"),
              rowCount: productRows.length,
              complete: result.productApi.status === "returned" || result.productApi.status === "empty",
              ...(!productCapability?.productDailySync ? { note: "本次为只读探测；常规同步尚未接入此范围。" } : {}),
            });
            const holdingApi = productType === "flexible" ? result.holdingsApi : result.fixedHoldingsApi;
            setResult("bitget-global", asset, productType, "holdingApi", {
              status: holdingApi.status === "error" ? "error" : holdingApi.complete ? holdingApi.rowCount ? "returned" : "empty" : "partial",
              ids: holdingApi.rows.map((row) => row.productId).filter((id): id is string => Boolean(id)),
              rows: sanitizeApiRows(holdingApi.rows, "productId", true),
              rowCount: holdingApi.rowCount,
              complete: holdingApi.complete,
              note: "本次只读探测；不会读取或返回持仓金额。",
            });
          }
        }
      }));
    }

    const okxCredential = credentials["okx-global"];
    if (credentialReady("okx-global")) {
      jobs.push(withSyncPlatform("okx-global", async () => {
        const okxCredentials = {
          apiKey: okxCredential!.apiKey,
          apiSecret: okxCredential!.apiSecret,
          passphrase: okxCredential!.passphrase!,
        };
        try {
          const result = await fetchOkxSavingsHoldings(okxCredentials);
          for (const asset of availableApiAssetsFor("okx-global", "flexible", "holdingApi")) {
            const present = result.observedAssets.includes(asset);
            setResult("okx-global", asset, "flexible", "holdingApi", {
              status: present ? "returned" : "empty",
              ids: present ? [asset] : [],
              rowCount: present ? 1 : 0,
              note: "余额接口；只报告币种是否出现，不报告金额。",
            });
          }
        } catch {
          for (const asset of availableApiAssetsFor("okx-global", "flexible", "holdingApi")) setResult("okx-global", asset, "flexible", "holdingApi", { status: "error", complete: false });
        }
        try {
          const result = await fetchOkxOnchainOffers(okxCredentials);
          for (let index = 0; index < monitoredAssets.length; index += 1) {
            const asset = monitoredAssets[index];
            const offerResult = result.byAsset[asset];
            const complete = offerResult.rowCount === offerResult.rows.length;
            supplementalProbes[0].assets[index] = {
              asset,
              status: !complete ? "partial" : offerResult.rowCount ? "returned" : "empty",
              rowCount: offerResult.rowCount,
              rows: sanitizeApiRows(
                offerResult.rows as unknown as Array<Record<string, unknown>>,
                "id",
                false,
              ),
              complete,
              note: complete
                ? "一次请求返回 On-chain Earn offers；不是普通 Savings 产品目录。"
                : `接口共返回 ${offerResult.rowCount} 行；报告仅展示前 ${offerResult.rows.length} 行，且不是普通 Savings 产品目录。`,
            };
          }
        } catch {
          for (let index = 0; index < monitoredAssets.length; index += 1) {
            supplementalProbes[0].assets[index] = {
              asset: monitoredAssets[index],
              status: "error",
              rowCount: null,
              rows: [],
              complete: false,
              note: "请求失败；安全错误摘要见 apiFailureSummary。",
            };
          }
        }
      }));
    }

    await Promise.all(jobs);
  });

  for (const record of captured) applyCapturedRecord(record, setResult);
  const checks = buildCapabilityChecks(scopes);
  return {
    generatedAt: new Date().toISOString(),
    dataChangesCommitted: false,
    includesHoldingAmounts: false,
    checkedScopeCount: checks.length / 2,
    checkedItemCount: checks.length,
    checks,
    additionalProbes: supplementalProbes,
    apiFailureSummary: summarizePlatformApiFailures(captured),
  };
}

type CapabilityCheck = {
  accountId: string;
  platform: string;
  region: string;
  asset: string;
  productType: CapabilityProductType;
  item: "product_apr" | "holding";
  apiSupport: "支持" | "不支持" | "待确认";
  result: {
    status: ProbeStatus;
    label: string;
    rowCount: number | null;
    rows: SafeApiRow[];
    rateSummary?: ApiProbe["rateSummary"];
    complete: boolean | null;
    checkedAt: string | null;
    note?: string;
  };
  api: {
    mode: "public" | "authenticated" | "manual";
    method: "GET" | null;
    path: string | null;
    host: string | null;
    requiredPermission: string;
    officialDocs: string[];
  };
  dailySyncStatus: "已接入日常同步" | "仅探测" | "未接入" | "不适用／人工维护";
  holdingEmptyMeansZero: "yes" | "no" | "unverified" | null;
  holdingEmptyEvidence: string | null;
  regionalEvidence?: Array<{
    region: string;
    apiSupport: CapabilityCheck["apiSupport"];
    result: CapabilityCheck["result"];
    api: CapabilityCheck["api"];
  }>;
};

function buildCapabilityChecks(scopes: CapabilityScope[]): CapabilityCheck[] {
  const checks: CapabilityCheck[] = [];
  const mexcByScope = new Map<string, CapabilityCheck>();
  const platformLabels: Record<string, string> = {
    "binance-global": "Binance Global",
    "binance-bahrain": "Binance Bahrain",
    "bybit-global": "Bybit Global",
    "bybit-eu": "Bybit EU",
    "bitget-global": "Bitget Global",
    "okx-global": "OKX Global",
    "mexc-ph": "MEXC",
    "mexc-uk": "MEXC",
  };
  const regionLabels: Record<string, string> = {
    global: "Global",
    bahrain: "Bahrain",
    eu: "EU",
    philippines: "PH",
    uk: "UK",
  };

  for (const scope of scopes) {
    const capability = platformCapabilities.find((entry) => entry.accountId === scope.accountId
      && entry.asset === scope.asset && entry.productType === scope.productType);
    if (!capability) continue;
    for (const [field, item] of [["productApi", "product_apr"], ["holdingApi", "holding"]] as const) {
      const probe = scope[field];
      const reference = capabilityApiReference(scope.accountId, scope.asset as typeof monitoredAssets[number], scope.productType, field);
      const isManual = probe.mode === "unsupported";
      const api = {
        mode: (isManual ? "manual" : probe.mode) as CapabilityCheck["api"]["mode"],
        method: reference.method,
        path: reference.path,
        host: reference.host,
        requiredPermission: reference.permission,
        officialDocs: reference.officialDocs,
      };
      const isPrivateHolding = item === "holding";
      const safeHoldingStatus = isPrivateHolding && (probe.status === "returned" || probe.status === "empty")
        ? "checked"
        : probe.status;
      const result = {
        status: safeHoldingStatus,
        label: isPrivateHolding ? holdingStatusLabel(probe.status) : probe.statusLabel,
        rowCount: isPrivateHolding ? null : probe.rowCount,
        rows: isPrivateHolding ? [] : probe.rows,
        ...(!isPrivateHolding && probe.rateSummary ? { rateSummary: probe.rateSummary } : {}),
        complete: probe.complete,
        checkedAt: probe.checkedAt,
        ...(probe.note ? { note: probe.note } : {}),
      };
      const apiSupport = apiSupportForMode(probe.mode);
      const dailySyncStatus = isManual
        ? "不适用／人工维护"
        : probe.dailySyncEnabled
          ? "已接入日常同步"
          : probe.checkedAt
            ? "仅探测"
            : "未接入";
      const record: CapabilityCheck = {
        accountId: scope.accountId,
        platform: platformLabels[scope.accountId] ?? scope.accountId,
        region: scope.accountId.startsWith("mexc-") ? "PH/UK" : regionLabels[capability.region],
        asset: scope.asset,
        productType: scope.productType,
        item,
        apiSupport,
        result,
        api,
        dailySyncStatus,
        holdingEmptyMeansZero: item === "holding" ? reference.emptyHoldingMeansZero : null,
        holdingEmptyEvidence: item === "holding" ? reference.emptyHoldingEvidence : null,
      };
      if (scope.accountId.startsWith("mexc-")) {
        const key = `${scope.asset}:${scope.productType}:${item}`;
        const existing = mexcByScope.get(key);
        const regionalEvidence = {
          region: regionLabels[capability.region],
          apiSupport,
          result,
          api,
        };
        if (existing) existing.regionalEvidence?.push(regionalEvidence);
        else {
          record.regionalEvidence = [regionalEvidence];
          mexcByScope.set(key, record);
          checks.push(record);
        }
      } else {
        checks.push(record);
      }
    }
  }
  return checks;
}

export function apiSupportForMode(mode: PlatformApiMode): CapabilityCheck["apiSupport"] {
  return mode === "unsupported" ? "不支持" : "支持";
}

function holdingStatusLabel(status: ProbeStatus) {
  switch (status) {
    case "unsupported": return "项目没有可用接口";
    case "not_configured": return "未配置";
    case "not_checked": return "未检查";
    case "checked":
    case "returned":
    case "empty": return "接口调用成功；账户结果不公开";
    case "partial": return "部分返回；账户结果不公开";
    case "error": return "请求失败";
  }
}

/** Return safe, compact upstream failure details without response bodies or request identifiers. */
export function summarizePlatformApiFailures(records: Array<Record<string, unknown>>) {
  const requests = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const event = record.event;
    if (!["exchange_http", "exchange_payload", "exchange_body_error"].includes(String(event))) continue;
    const requestId = typeof record.requestId === "string" ? record.requestId : `unlinked-${requests.size}`;
    const current = requests.get(requestId) ?? {};
    requests.set(requestId, { ...current, ...record });
  }

  const knownHosts = new Set([
    "api-gcp.binance.com", "api.binance.com", "api.bybit.com", "api.bytick.com", "api.bybit.eu",
    "api.bitget.com", "openapi.okx.com", "www.okx.com",
  ]);
  const allowedAccounts = new Set(platformCapabilities.map((entry) => entry.accountId));
  const grouped = new Map<string, {
    accountId: string | null;
    host?: string;
    endpoint?: string;
    asset?: string;
    reason: string;
    httpStatus?: number;
    apiCode?: string;
    accessReason?: string;
    requestCount: number;
  }>();

  for (const record of requests.values()) {
    const httpStatus = Number.isInteger(record.httpStatus) ? record.httpStatus as number : undefined;
    const apiCode = typeof record.apiCode === "string" ? record.apiCode : undefined;
    const accessReason = typeof record.accessReason === "string" ? record.accessReason : undefined;
    const outcome = typeof record.outcome === "string" ? record.outcome : undefined;
    const errorKind = typeof record.errorKind === "string" ? record.errorKind : undefined;
    const bodyInvalid = record.bodyKind === "invalid_json";
    const apiRejected = apiCode !== undefined && !["0", "00000", "absent"].includes(apiCode);
    const httpFailed = httpStatus !== undefined && (httpStatus < 200 || httpStatus >= 300);
    if (!outcome && !errorKind && !accessReason && !bodyInvalid && !apiRejected && !httpFailed) continue;

    const rawPlatform = typeof record.platform === "string" ? record.platform : "";
    const host = typeof record.host === "string" && knownHosts.has(record.host) ? record.host : undefined;
    const accountId = allowedAccounts.has(rawPlatform)
      ? rawPlatform
      : host === "api.bybit.eu"
        ? "bybit-eu"
        : host && ["api.bybit.com", "api.bytick.com"].includes(host)
          ? "bybit-global"
          : null;
    const rawEndpoint = typeof record.endpoint === "string" ? record.endpoint : "";
    const endpoint = /^\/[a-zA-Z0-9/_-]{1,120}$/.test(rawEndpoint) ? rawEndpoint : undefined;
    const asset = ["USDT", "USDC", "USDGO", "BTC"].includes(String(record.asset)) ? String(record.asset) : undefined;
    const reason = outcome ?? accessReason ?? errorKind ?? (bodyInvalid ? "invalid_json" : apiRejected ? "api_rejected" : `http_${httpStatus}`);
    const key = JSON.stringify([accountId, host, endpoint, asset, reason, httpStatus, apiCode, accessReason]);
    const existing = grouped.get(key);
    if (existing) existing.requestCount += 1;
    else grouped.set(key, {
      accountId,
      ...(host ? { host } : {}),
      ...(endpoint ? { endpoint } : {}),
      ...(asset ? { asset } : {}),
      reason,
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(apiRejected ? { apiCode } : {}),
      ...(accessReason ? { accessReason } : {}),
      requestCount: 1,
    });
  }
  return [...grouped.values()].slice(0, 80);
}

function initialApi(mode: PlatformApiMode, dailySyncEnabled: boolean, credentialReady: boolean): ApiProbe {
  const status: ProbeStatus = mode === "unsupported"
    ? "unsupported"
    : mode === "authenticated" && !credentialReady ? "not_configured" : "not_checked";
  return {
    mode,
    dailySyncEnabled,
    status,
    statusLabel: statusLabel(status, 0),
    rowCount: null,
    ids: [],
    rows: [],
    complete: null,
    checkedAt: null,
    ...(status === "unsupported" ? { note: "项目目前没有可用接口；按人工方式维护。" } : {}),
    ...(status === "not_checked" && !dailySyncEnabled ? { note: "接口已知，但日常同步尚未接入。" } : {}),
  };
}

function statusLabel(status: ProbeStatus, rowCount: number) {
  switch (status) {
    case "unsupported": return "项目没有可用接口";
    case "not_configured": return "未配置";
    case "not_checked": return "未检查";
    case "checked": return "接口调用成功；账户结果不公开";
    case "returned": return `有数据（${rowCount} 条）`;
    case "empty": return "成功但空";
    case "partial": return "部分返回";
    case "error": return "请求失败";
  }
}

function applyCapturedRecord(
  record: Record<string, unknown>,
  setResult: (
    accountId: string,
    asset: string,
    productType: CapabilityProductType,
    field: "productApi" | "holdingApi",
    result: { status: ProbeStatus; ids?: string[]; rows?: SafeApiRow[]; rowCount?: number; complete?: boolean; note?: string },
  ) => void,
) {
  const rows = (value: unknown) => Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
  const strings = (value: unknown) => typeof value === "string" && value ? [value] : [];
  if (record.event === "binance_flexible_rows") {
    const accountId = String(record.platform ?? "");
    const asset = String(record.asset ?? "");
    for (const [field, key, countKey, completeKey] of [
      ["productApi", "productRows", "productRowCount", "productListComplete"],
      ["holdingApi", "positionRows", "positionRowCount", "positionListComplete"],
    ] as const) {
      const entries = rows(record[key]);
      const complete = record[completeKey] === true;
      const rowCount = typeof record[countKey] === "number" ? record[countKey] as number : entries.length;
      setResult(accountId, asset, "flexible", field, {
        status: complete ? rowCount ? "returned" : "empty" : "partial",
        ids: entries.flatMap((entry) => strings(entry.productId)),
        rows: sanitizeApiRows(entries, "productId", field === "holdingApi"),
        rowCount,
        complete,
      });
    }
    return;
  }
  if (record.event === "binance_locked_rows") {
    const accountId = String(record.platform ?? "");
    for (const asset of monitoredAssets) {
      for (const [field, key, completeKey, idKey] of [
        ["productApi", "productRows", "productListComplete", "externalProjectId"],
        ["holdingApi", "positionRows", "positionListComplete", "externalProjectId"],
      ] as const) {
        const entries = rows(record[key]).filter((entry) => String(entry.asset ?? "").toUpperCase() === asset);
        const complete = record[completeKey] === true;
        setResult(accountId, asset, "fixed", field, {
          status: complete ? entries.length ? "returned" : "empty" : "partial",
          ids: entries.flatMap((entry) => strings(entry[idKey])),
          rows: sanitizeApiRows(entries, idKey, field === "holdingApi"),
          rowCount: entries.length,
          complete,
        });
      }
    }
    return;
  }
  if (record.event === "bybit_flexible_rows") {
    const accountId = record.platform === "Bybit EU" ? "bybit-eu" : "bybit-global";
    const asset = String(record.coin ?? "");
    const entries = rows(record.rows);
    const included = rows(record.includedProducts);
    const rowCount = typeof record.rowCount === "number" ? record.rowCount : entries.length;
    const idsWithUsableRates = new Set(included.flatMap((entry) => strings(entry.productId)));
    const incomplete = Number(record.unmappedRowCount ?? 0) > 0
      || Number(record.scopeMismatchCount ?? 0) > 0
      || entries.length !== rowCount
      || entries.some((entry) => !strings(entry.productId).length || !idsWithUsableRates.has(String(entry.productId)));
    const safeRows = sanitizeApiRows(entries, "productId", false).map((row) => ({
      ...row,
      rateShape: row.id && idsWithUsableRates.has(row.id) ? row.rateShape : "no_rate" as const,
    }));
    setResult(accountId, asset, "flexible", "productApi", {
      status: incomplete ? "partial" : rowCount ? "returned" : "empty",
      ids: entries.flatMap((entry) => strings(entry.productId)),
      rows: safeRows,
      rowCount,
      complete: !incomplete,
    });
    return;
  }
  if (record.event === "bybit_flexible_position_rows") {
    const accountId = String(record.account ?? "");
    const asset = String(record.asset ?? "");
    const entries = rows(record.rows);
    const complete = record.listComplete === true
      && Number(record.scopeMismatchCount ?? 0) === 0
      && Number(record.missingIdentityCount ?? 0) === 0
      && Number(record.invalidAmountCount ?? 0) === 0;
    setResult(accountId, asset, "flexible", "holdingApi", {
      status: !complete ? "partial" : entries.length ? "returned" : "empty",
      ids: entries.flatMap((entry) => strings(entry.productId)),
      rows: sanitizeApiRows(entries, "productId", true),
      rowCount: typeof record.rowCount === "number" ? record.rowCount : entries.length,
      complete,
    });
    return;
  }
  if (record.event === "bybit_fixed_rows") {
    const accountId = String(record.platform ?? "");
    for (const [field, key, statusKey, idKey] of [
      ["productApi", "productRows", "productApiStatus", "productId"],
      ["holdingApi", "positionRows", "holdingsApiStatus", "productId"],
    ] as const) {
      const all = rows(record[key]);
      for (const asset of monitoredAssets) {
        const entries = all.filter((entry) => String(entry.coin ?? "").toUpperCase() === asset);
        const endpointStatus = record[statusKey];
        const endpointOk = endpointStatus === "success";
        const identityRows = entries.map((entry) => ({
          ...entry,
          productId: bybitFixedIdentityId(entry.productId, entry.duration),
        }));
        setResult(accountId, asset, "fixed", field, {
          status: endpointStatus === "error"
            ? "error"
            : endpointStatus === "partial"
              ? "partial"
              : entries.length ? "returned" : "empty",
          ids: identityRows.flatMap((entry) => strings(entry.productId)),
          rows: sanitizeApiRows(identityRows, idKey, field === "holdingApi"),
          rowCount: entries.length,
          complete: endpointOk,
        });
      }
    }
  }
}

function bybitFixedIdentityId(value: unknown, durationValue: unknown) {
  const productId = typeof value === "string" ? value.trim() : "";
  if (!productId) return null;
  const duration = typeof durationValue === "string" ? durationValue.trim().toLowerCase() : "";
  return duration && /^\d+(?:\.\d+)?[dhm]$/.test(duration) ? `${productId}@${duration}` : productId;
}

function safeLiveRateRow(rate: LiveRate): SafeApiRow {
  const tierCount = rate.rateShape === "single_rate" ? 0 : rate.tiers?.length ?? 0;
  const hasBaseRate = rate.rateCoverage
    ? rate.rateCoverage !== "unavailable"
    : Number.isFinite(rate.apr);
  const row: SafeApiRow = { id: rate.externalProductId ?? null };
  if (rate.availability) row.status = rate.availability;
  row.rateShape = rate.rateShape ?? (tierCount ? "tiered_rate" : hasBaseRate ? "single_rate" : "no_rate");
  if (tierCount) row.tierCount = tierCount;
  if (rate.termDays !== undefined) row.duration = String(rate.termDays);
  return row;
}

function mergeSafeApiRows(previous: SafeApiRow[], incoming: SafeApiRow[]) {
  const previousById = new Map(previous.map((row) => [row.id, row]));
  return incoming.map((row) => {
    const old = previousById.get(row.id);
    if (!old) return row;
    return {
      ...old,
      ...row,
      rateShape: row.rateShape ?? old.rateShape,
      tierCount: row.tierCount ?? old.tierCount,
    };
  });
}

function sanitizeApiRows(rows: Array<Record<string, unknown>>, idKey: string, holding: boolean, rateKind?: "apr" | "apy"): SafeApiRow[] {
  return rows.map((row) => {
    const id = typeof row[idKey] === "string" && row[idKey] ? row[idKey] as string : null;
    const safe: SafeApiRow = { id };
    if (typeof row.status === "string") safe.status = row.status;
    if (typeof row.productLevel === "string") safe.productLevel = row.productLevel;
    if (typeof row.periodType === "string") safe.periodType = row.periodType;
    if (typeof row.period === "string" || typeof row.period === "number") safe.period = String(row.period);
    if (typeof row.duration === "string" || typeof row.duration === "number") safe.duration = String(row.duration);
    if (typeof row.asset === "string") safe.asset = row.asset;
    if (typeof row.protocol === "string") safe.protocol = row.protocol;
    if (typeof row.protocolType === "string") safe.protocolType = row.protocolType;
    if (typeof row.term === "string" || typeof row.term === "number") safe.term = String(row.term);
    if (!holding) {
      const tierCount = countRateTiers(row);
      const tieredRateReturned = hasRateInTiers(row, rateKind);
      const baseRateReturned = [row.apr, row.estimateApr, row.apy, row.estimateApy, row.latestAnnualPercentageRate]
        .some((value) => safeNumber(value) !== undefined);
      if (tierCount !== undefined) safe.tierCount = tierCount;
      safe.rateShape = row.rateShape === "single_rate" || row.rateShape === "tiered_rate" || row.rateShape === "no_rate"
        ? row.rateShape
        : tieredRateReturned ? "tiered_rate" : baseRateReturned ? "single_rate" : "no_rate";
    }
    if (typeof row.eligibleForMonitoring === "boolean") safe.eligibleForMonitoring = row.eligibleForMonitoring;
    if (typeof row.isVip === "boolean") safe.isVip = row.isVip;
    if (typeof row.specialUserGroupRequired === "boolean") safe.specialUserGroupRequired = row.specialUserGroupRequired;
    return safe;
  });
}

function countRateTiers(row: Record<string, unknown>) {
  const raw = Array.isArray(row.tiers)
    ? row.tiers
    : Array.isArray(row.tierAprDetails)
      ? row.tierAprDetails
      : Array.isArray(row.tieredApyList)
        ? row.tieredApyList
        : Array.isArray(row.tierAnnualPercentageRate)
          ? row.tierAnnualPercentageRate
          : row.tierAnnualPercentageRate && typeof row.tierAnnualPercentageRate === "object"
            ? Object.keys(row.tierAnnualPercentageRate)
            : undefined;
  return raw?.length;
}

function hasRateInTiers(row: Record<string, unknown>, rateKind?: "apr" | "apy") {
  const raw = Array.isArray(row.tiers)
    ? row.tiers
    : Array.isArray(row.tierAprDetails)
      ? row.tierAprDetails
      : Array.isArray(row.tieredApyList)
        ? row.tieredApyList
        : Array.isArray(row.tierAnnualPercentageRate)
          ? row.tierAnnualPercentageRate
        : [];
  return raw.some((value) => {
    if (!value || typeof value !== "object") return false;
    const tier = value as Record<string, unknown>;
    const apr = safeNumber(tier.apr ?? tier.estimateApr);
    const apy = safeNumber(tier.apy ?? tier.estimateApy ?? tier.currentApy);
    return rateKind === "apy" ? apy !== undefined || apr !== undefined : apr !== undefined || apy !== undefined;
  });
}

function safeNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value.replaceAll(",", "").replaceAll("%", ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function summarizeRateShapes(rows: SafeApiRow[]) {
  return {
    singleRateRows: rows.filter((row) => row.rateShape === "single_rate").length,
    tieredRateRows: rows.filter((row) => row.rateShape === "tiered_rate").length,
    noRateRows: rows.filter((row) => row.rateShape === "no_rate").length,
    unknownRateRows: rows.filter((row) => !row.rateShape).length,
  };
}

function externalIdFromScoped(value: string) {
  const marker = value.lastIndexOf(":");
  return marker >= 0 ? value.slice(marker + 1) : value;
}

function limitedUnique(values: string[]) {
  return [...new Set(values.filter(Boolean))].slice(0, reportIdLimit);
}
