import { fetchBinanceFlexibleSnapshot, fetchBinanceLockedSnapshot } from "@/lib/integrations/binance";
import { probeBitgetAssets } from "@/lib/integrations/bitget";
import { bybitGlobalApiBases, fetchBybitFlexibleHoldings, fetchBybitShortFixedSnapshots, probeBybitFixedProducts, probeBybitFlexibleProducts } from "@/lib/integrations/bybit";
import { fetchOkxSavingsHoldings } from "@/lib/integrations/okx";
import { apiAssetsFor, monitoredAssets, platformCapabilities, type CapabilityProductType, type PlatformApiMode } from "@/lib/platform-capabilities";
import { collectSyncDiagnostics, withSyncPlatform } from "@/lib/sync-diagnostics";

type ProbeCredential = { apiKey: string; apiSecret: string; passphrase?: string };
type ProbeStatus = "not_integrated" | "not_configured" | "not_checked" | "returned" | "empty" | "partial" | "error";
type SafeApiRow = {
  id: string | null;
  status?: string;
  productLevel?: string;
  periodType?: string;
  duration?: string;
  tierCount?: number;
  eligibleForMonitoring?: boolean;
  hasPositiveHolding?: boolean;
  isVip?: boolean;
  specialUserGroupRequired?: boolean;
};
type ApiProbe = {
  mode: PlatformApiMode;
  status: ProbeStatus;
  rowCount: number | null;
  ids: string[];
  rows: SafeApiRow[];
  complete: boolean | null;
  note?: string;
};
type CapabilityScope = {
  accountId: string;
  asset: string;
  productType: CapabilityProductType;
  productApi: ApiProbe;
  holdingApi: ApiProbe;
  idMatch: null | { matchedIds: string[]; productOnlyIds: string[]; holdingOnlyIds: string[] };
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
    productApi: initialApi(capability.productApi, credentialReady(capability.accountId)),
    holdingApi: initialApi(capability.holdingApi, credentialReady(capability.accountId)),
    idMatch: null,
  }));

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
    scope[field] = {
      ...scope[field],
      status: result.status,
      rowCount: result.rowCount ?? result.ids?.length ?? 0,
      ids: limitedUnique(result.ids ?? []),
      rows: (result.rows ?? (result.ids ?? []).map((id) => ({ id }))).slice(0, reportIdLimit),
      complete: result.complete ?? (result.status === "returned" || result.status === "empty"),
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
      for (const asset of monitoredAssets) {
        jobs.push((async () => {
          try {
            const rows = await probeBybitFlexibleProducts(accountId, asset);
            const configuredMode = platformCapabilities.find((entry) => (
              entry.accountId === accountId && entry.asset === asset && entry.productType === "flexible"
            ))?.productApi;
            setResult(accountId, asset, "flexible", "productApi", {
              status: rows.length ? "returned" : "empty",
              ids: rows.map((row) => row.productId).filter((id): id is string => Boolean(id)),
              rows: rows.map((row) => ({
                id: row.productId,
                ...(row.status ? { status: row.status } : {}),
                ...(row.tierCount !== undefined ? { tierCount: row.tierCount } : {}),
              })),
              rowCount: rows.length,
              complete: true,
              ...(configuredMode === "manual" ? { note: "本次通过公开接口只读检查；常规同步尚未接入此范围。" } : {}),
            });
          } catch {
            setResult(accountId, asset, "flexible", "productApi", { status: "error", complete: false });
          }
        })());
      }
    }

    jobs.push((async () => {
      try {
        const rows = await probeBybitFixedProducts("bybit-eu");
        for (const asset of monitoredAssets) {
          const assetRows = rows.filter((row) => row.coin === asset);
          setResult("bybit-eu", asset, "fixed", "productApi", {
            status: assetRows.length ? "returned" : "empty",
            ids: assetRows.map((row) => row.externalProductId),
            rows: assetRows.map((row) => ({
              id: row.externalProductId,
              status: row.status ?? undefined,
              duration: row.duration,
              tierCount: row.tierCount,
              isVip: row.isVip,
              specialUserGroupRequired: row.specialUserGroupRequired,
            })),
            rowCount: assetRows.length,
            complete: true,
            note: "本次通过公开接口只读检查；Bybit EU 定期常规同步尚未接入。",
          });
        }
      } catch {
        for (const asset of monitoredAssets) {
          setResult("bybit-eu", asset, "fixed", "productApi", { status: "error", complete: false });
        }
      }
    })());

    for (const [accountId, region] of [["binance-global", "global"], ["binance-bahrain", "bahrain"]] as const) {
      const credential = credentials[accountId];
      if (!credentialReady(accountId)) continue;
      const binanceCredential = { apiKey: credential!.apiKey, apiSecret: credential!.apiSecret };
      for (const asset of monitoredAssets) {
        jobs.push(withSyncPlatform(accountId, async () => {
          try {
            const result = await fetchBinanceFlexibleSnapshot(binanceCredential, region, [asset], true);
            const rates = result.rates.filter((rate) => rate.catalog?.asset === asset);
            const positiveHoldingIds = Object.entries(result.holdings)
              .filter(([, amount]) => amount > 0)
              .map(([identity]) => externalIdFromScoped(identity));
            setResult(accountId, asset, "flexible", "productApi", {
              status: result.productListsComplete ? rates.length ? "returned" : "empty" : "partial",
              ids: rates.map((rate) => rate.externalProductId).filter((id): id is string => Boolean(id)),
              rowCount: rates.length,
              complete: result.productListsComplete,
              ...(!apiAssetsFor(accountId, "flexible", "productApi").includes(asset)
                ? { note: "本次通过现有账户接口只读检查；常规同步尚未接入此资产。" }
                : {}),
            });
            setResult(accountId, asset, "flexible", "holdingApi", {
              status: result.positionListsComplete ? positiveHoldingIds.length ? "returned" : "empty" : "partial",
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
              status: result.productListComplete ? rates.length ? "returned" : "empty" : "partial",
              ids: rates.map((rate) => rate.externalProductId).filter((id): id is string => Boolean(id)),
              rowCount: rates.length,
              complete: result.productListComplete,
            });
            setResult(accountId, asset, "fixed", "holdingApi", {
              status: result.positionListComplete ? positions.length ? "returned" : "empty" : "partial",
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
          const result = await fetchBybitFlexibleHoldings(bybit, "global", monitoredAssets);
          for (const asset of monitoredAssets) {
            const failed = result.sync.failedAssets.includes(asset);
            const ids = Object.keys(result.holdings)
              .filter((identity) => identity.includes(`:${asset}:flexible:`))
              .map((identity) => externalIdFromScoped(identity));
            setResult("bybit-global", asset, "flexible", "holdingApi", {
              status: failed ? "error" : ids.length ? "returned" : "empty",
              ids,
              rowCount: ids.length,
              complete: !failed,
              ...(!apiAssetsFor("bybit-global", "flexible", "holdingApi").includes(asset)
                ? { note: "本次通过现有账户接口只读检查；常规同步尚未接入此资产。" }
                : {}),
            });
          }
        } catch {
          for (const asset of monitoredAssets) setResult("bybit-global", asset, "flexible", "holdingApi", { status: "error", complete: false });
        }
      }));
      jobs.push(withSyncPlatform("bybit-global", async () => {
        try {
          const result = await fetchBybitShortFixedSnapshots(bybit);
          for (const asset of monitoredAssets) {
            const rates = result.rates.filter((rate) => rate.catalog?.asset === asset);
            const ids = Object.keys(result.holdings)
              .filter((identity) => identity.includes(`:${asset}:fixed:`))
              .map((identity) => externalIdFromScoped(identity));
            setResult("bybit-global", asset, "fixed", "productApi", {
              status: result.sync.products ? rates.length ? "returned" : "empty" : "error",
              ids: rates.map((rate) => rate.externalProductId).filter((id): id is string => Boolean(id)),
              rowCount: rates.length,
              complete: result.sync.products,
            });
            setResult("bybit-global", asset, "fixed", "holdingApi", {
              status: result.sync.holdings ? ids.length ? "returned" : "empty" : "error",
              ids,
              rowCount: ids.length,
              complete: result.sync.holdings,
            });
          }
        } catch {
          for (const asset of monitoredAssets) setError("bybit-global", asset, "fixed", ["productApi", "holdingApi"]);
        }
      }));
    }

    const bybitEuCredential = credentials["bybit-eu"];
    if (!credentialReady("bybit-eu")) {
      for (const asset of monitoredAssets) {
        setResult("bybit-eu", asset, "flexible", "holdingApi", {
          status: "not_configured",
          complete: false,
          note: "Bybit EU 持仓接口需要该区域的只读 API 凭证；配置后仅用于本次检查。",
        });
      }
    } else {
      jobs.push(withSyncPlatform("bybit-eu", async () => {
        try {
          const result = await fetchBybitFlexibleHoldings({
            apiKey: bybitEuCredential!.apiKey,
            apiSecret: bybitEuCredential!.apiSecret,
            baseUrls: ["https://api.bybit.eu"],
          }, "eu", monitoredAssets);
          for (const asset of monitoredAssets) {
            const failed = result.sync.failedAssets.includes(asset);
            const ids = Object.keys(result.holdings)
              .filter((identity) => identity.startsWith(`bybit-eu:${asset}:flexible:`))
              .map((identity) => externalIdFromScoped(identity));
            setResult("bybit-eu", asset, "flexible", "holdingApi", {
              status: failed ? "error" : ids.length ? "returned" : "empty",
              ids,
              rowCount: ids.length,
              complete: !failed,
              note: "本次只读检查；该凭证不会用于日常同步。",
            });
          }
        } catch {
          for (const asset of monitoredAssets) {
            setResult("bybit-eu", asset, "flexible", "holdingApi", { status: "error", complete: false });
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
            const productMode = platformCapabilities.find((item) => item.accountId === "bitget-global" && item.asset === asset && item.productType === productType)?.productApi ?? "manual";
            setResult("bitget-global", asset, productType, "productApi", {
              status: result.productApi.status === "error" ? "error" : productRows.length ? "returned" : "empty",
              ids: productRows.map((row) => row.productId).filter((id): id is string => Boolean(id)),
              rows: sanitizeApiRows(productRows, "productId", false),
              rowCount: productRows.length,
              complete: result.productApi.status !== "error",
              ...(productMode === "manual" ? { note: "本次为只读探测；常规同步尚未接入此范围。" } : {}),
            });
          }
          setResult("bitget-global", asset, "flexible", "holdingApi", {
            status: result.holdingsApi.status === "error" ? "error" : result.holdingsApi.complete ? result.holdingsApi.rowCount ? "returned" : "empty" : "partial",
            ids: result.holdingsApi.rows.map((row) => row.productId).filter((id): id is string => Boolean(id)),
            rows: sanitizeApiRows(result.holdingsApi.rows, "productId", true),
            rowCount: result.holdingsApi.rowCount,
            complete: result.holdingsApi.complete,
          });
        }
      }));
    }

    const okxCredential = credentials["okx-global"];
    if (credentialReady("okx-global")) {
      jobs.push(withSyncPlatform("okx-global", async () => {
        try {
          const result = await fetchOkxSavingsHoldings({
            apiKey: okxCredential!.apiKey,
            apiSecret: okxCredential!.apiSecret,
            passphrase: okxCredential!.passphrase!,
          });
          for (const asset of monitoredAssets) {
            const present = result.observedAssets.includes(asset);
            setResult("okx-global", asset, "flexible", "holdingApi", {
              status: present ? "returned" : "empty",
              ids: present ? [asset] : [],
              rowCount: present ? 1 : 0,
              note: "余额接口；只报告币种是否出现，不报告金额。",
            });
          }
        } catch {
          for (const asset of monitoredAssets) setResult("okx-global", asset, "flexible", "holdingApi", { status: "error", complete: false });
        }
      }));
    }

    await Promise.all(jobs);
  });

  for (const record of captured) applyCapturedRecord(record, setResult);
  for (const scope of scopes) {
    if (["returned", "empty"].includes(scope.productApi.status) && ["returned", "empty"].includes(scope.holdingApi.status)) {
      const products = new Set(scope.productApi.ids);
      const holdings = new Set(scope.holdingApi.ids);
      scope.idMatch = {
        matchedIds: [...products].filter((id) => holdings.has(id)),
        productOnlyIds: [...products].filter((id) => !holdings.has(id)),
        holdingOnlyIds: [...holdings].filter((id) => !products.has(id)),
      };
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    dataChangesCommitted: false,
    includesHoldingAmounts: false,
    checkedScopeCount: scopes.length,
    scopes,
  };
}

function initialApi(mode: PlatformApiMode, credentialReady: boolean): ApiProbe {
  const status = mode === "manual" ? "not_integrated" : mode === "authenticated" && !credentialReady ? "not_configured" : "not_checked";
  return { mode, status, rowCount: null, ids: [], rows: [], complete: null };
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
    setResult(accountId, asset, "flexible", "productApi", {
      status: entries.length ? "returned" : "empty",
      ids: entries.flatMap((entry) => strings(entry.productId)),
      rows: sanitizeApiRows(entries, "productId", false),
      rowCount: typeof record.rowCount === "number" ? record.rowCount : entries.length,
    });
    return;
  }
  if (record.event === "bybit_flexible_position_rows") {
    const accountId = String(record.account ?? "");
    const asset = String(record.asset ?? "");
    const entries = rows(record.rows);
    setResult(accountId, asset, "flexible", "holdingApi", {
      status: entries.length ? "returned" : "empty",
      ids: entries.flatMap((entry) => strings(entry.productId)),
      rows: sanitizeApiRows(entries, "productId", true),
      rowCount: typeof record.rowCount === "number" ? record.rowCount : entries.length,
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

function sanitizeApiRows(rows: Array<Record<string, unknown>>, idKey: string, holding: boolean): SafeApiRow[] {
  return rows.map((row) => {
    const id = typeof row[idKey] === "string" && row[idKey] ? row[idKey] as string : null;
    const tiers = Array.isArray(row.tiers)
      ? row.tiers.length
      : Array.isArray(row.tierAnnualPercentageRate)
        ? row.tierAnnualPercentageRate.length
        : row.tierAnnualPercentageRate && typeof row.tierAnnualPercentageRate === "object"
          ? Object.keys(row.tierAnnualPercentageRate).length
          : undefined;
    const safe: SafeApiRow = { id };
    if (typeof row.status === "string") safe.status = row.status;
    if (typeof row.productLevel === "string") safe.productLevel = row.productLevel;
    if (typeof row.periodType === "string") safe.periodType = row.periodType;
    if (typeof row.duration === "string" || typeof row.duration === "number") safe.duration = String(row.duration);
    if (tiers !== undefined) safe.tierCount = tiers;
    if (typeof row.eligibleForMonitoring === "boolean") safe.eligibleForMonitoring = row.eligibleForMonitoring;
    if (typeof row.isVip === "boolean") safe.isVip = row.isVip;
    if (typeof row.specialUserGroupRequired === "boolean") safe.specialUserGroupRequired = row.specialUserGroupRequired;
    if (holding) {
      if (typeof row.hasPositiveHolding === "boolean") safe.hasPositiveHolding = row.hasPositiveHolding;
      else if (typeof row.amount === "number") safe.hasPositiveHolding = row.amount > 0;
      else if (typeof row.totalAmount === "number") safe.hasPositiveHolding = row.totalAmount > 0;
    }
    return safe;
  });
}

function externalIdFromScoped(value: string) {
  const marker = value.lastIndexOf(":");
  return marker >= 0 ? value.slice(marker + 1) : value;
}

function limitedUnique(values: string[]) {
  return [...new Set(values.filter(Boolean))].slice(0, reportIdLimit);
}
