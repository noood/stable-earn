import type { Asset } from "./domain";

/** How the project can obtain a field, independent of routine-sync coverage. */
export type PlatformApiMode = "unsupported" | "public" | "authenticated";
export type CapabilityProductType = "flexible" | "fixed";
export type CapabilityField = "productApi" | "holdingApi";
export type EmptyHoldingVerdict = "yes" | "no" | "unverified";

export type CapabilityApiReference = {
  method: "GET" | null;
  path: string | null;
  host: string | null;
  permission: string;
  officialDocs: string[];
  /** Whether a complete empty response proves that this product has no holding. */
  emptyHoldingMeansZero: EmptyHoldingVerdict | null;
  emptyHoldingEvidence: string | null;
};

export const monitoredAssets = ["USDT", "USDC", "USDGO", "BTC"] as const satisfies readonly Asset[];

export type PlatformCapability = {
  accountId: string;
  exchange: AccountRule["exchange"];
  region: AccountRule["region"];
  asset: Asset;
  productType: CapabilityProductType;
  /** Product/APR information: public, authenticated, or no usable project API. */
  productApi: PlatformApiMode;
  /** Account holding/position information: kept separate from product data. */
  holdingApi: PlatformApiMode;
  /** Whether the corresponding API is called by routine synchronization. */
  productDailySync: boolean;
  holdingDailySync: boolean;
};

type AccountRule = {
  accountId: string;
  exchange: "binance" | "bybit" | "bitget" | "okx" | "mexc";
  region: "global" | "bahrain" | "eu" | "philippines" | "uk";
  flexible: Rule;
  fixed: Rule;
};

type Rule = {
  productAssets: readonly Asset[];
  holdingAssets: readonly Asset[];
  productDailyAssets: readonly Asset[];
  holdingDailyAssets: readonly Asset[];
  productApi: PlatformApiMode;
  holdingApi: PlatformApiMode;
};

const allAssets = monitoredAssets as readonly Asset[];
const none: readonly Asset[] = [];
const unsupported = (): Rule => ({
  productAssets: none,
  holdingAssets: none,
  productDailyAssets: none,
  holdingDailyAssets: none,
  productApi: "unsupported",
  holdingApi: "unsupported",
});

function rule(
  productAssets: readonly Asset[],
  holdingAssets: readonly Asset[],
  productApi: Exclude<PlatformApiMode, "unsupported">,
  holdingApi: Exclude<PlatformApiMode, "unsupported">,
  productDailyAssets: readonly Asset[],
  holdingDailyAssets: readonly Asset[],
): Rule {
  return { productAssets, holdingAssets, productApi, holdingApi, productDailyAssets, holdingDailyAssets };
}

const accountRules: AccountRule[] = [
  {
    accountId: "binance-global",
    exchange: "binance",
    region: "global",
    flexible: rule(allAssets, allAssets, "authenticated", "authenticated", allAssets, allAssets),
    fixed: rule(allAssets, allAssets, "authenticated", "authenticated", allAssets, allAssets),
  },
  {
    accountId: "binance-bahrain",
    exchange: "binance",
    region: "bahrain",
    flexible: rule(allAssets, allAssets, "authenticated", "authenticated", allAssets, allAssets),
    fixed: rule(allAssets, allAssets, "authenticated", "authenticated", allAssets, allAssets),
  },
  {
    accountId: "bybit-global",
    exchange: "bybit",
    region: "global",
    // The flexible Earn product/position endpoint rejects USDGO as an invalid
    // coin. BTC is supported by the same documented product and position APIs.
    flexible: rule(["USDT", "USDC", "BTC"], ["USDT", "USDC", "BTC"], "public", "authenticated", ["USDT", "USDC", "BTC"], ["USDT", "USDC", "BTC"]),
    fixed: rule(allAssets, allAssets, "public", "authenticated", allAssets, allAssets),
  },
  {
    accountId: "bybit-eu",
    exchange: "bybit",
    region: "eu",
    // EU product/APR data is public. The current EU key permissions do not
    // expose Earn positions, so holdings remain manual for both terms.
    flexible: rule(["USDT", "USDC", "BTC"], none, "public", "public", ["USDT", "USDC", "BTC"], none),
    fixed: rule(allAssets, none, "public", "public", allAssets, none),
  },
  {
    accountId: "bitget-global",
    exchange: "bitget",
    region: "global",
    // The authenticated Savings product and assets endpoints accept each
    // monitored coin and both period types. A successful empty list is data,
    // not evidence that the endpoint is unsupported.
    flexible: rule(allAssets, allAssets, "authenticated", "authenticated", allAssets, allAssets),
    fixed: rule(allAssets, allAssets, "authenticated", "authenticated", allAssets, allAssets),
  },
  {
    accountId: "okx-global",
    exchange: "okx",
    region: "global",
    // OKX returns coin-level Savings balances without product IDs. The app
    // tracks one flexible product per monitored coin, so a complete response
    // maps one-to-one; no ordinary fixed Savings position endpoint is available.
    flexible: rule(none, ["USDT", "USDC", "BTC"], "public", "authenticated", none, ["USDT", "USDC", "BTC"]),
    fixed: unsupported(),
  },
  {
    accountId: "mexc-ph",
    exchange: "mexc",
    region: "philippines",
    flexible: unsupported(),
    fixed: unsupported(),
  },
  {
    accountId: "mexc-uk",
    exchange: "mexc",
    region: "uk",
    flexible: unsupported(),
    fixed: unsupported(),
  },
];

function expandCapabilities(account: AccountRule): PlatformCapability[] {
  return (["flexible", "fixed"] as const).flatMap((productType) => {
    const current = account[productType];
    return monitoredAssets.map((asset) => ({
      accountId: account.accountId,
      exchange: account.exchange,
      region: account.region,
      asset,
      productType,
      productApi: current.productAssets.includes(asset) ? current.productApi : "unsupported",
      holdingApi: current.holdingAssets.includes(asset) ? current.holdingApi : "unsupported",
      productDailySync: current.productDailyAssets.includes(asset),
      holdingDailySync: current.holdingDailyAssets.includes(asset),
    }));
  });
}

/** Complete account × asset × product-type matrix: 8 × 4 × 2 = 64 rows. */
export const platformCapabilities = accountRules.flatMap(expandCapabilities);

export function platformCapability(accountId: string, productType: CapabilityProductType, asset: Asset) {
  return platformCapabilities.find((entry) => (
    entry.accountId === accountId && entry.productType === productType && entry.asset === asset
  ));
}

/** Stable key for completeness/archival evidence scoped to one account, asset and product type. */
export function platformCapabilityScopeKey(accountId: string, asset: Asset, productType: CapabilityProductType) {
  return `${accountId}:${asset}:${productType}`;
}

/** Assets enabled for routine sync; API availability alone does not enable a scope. */
export function apiAssetsFor(accountId: string, productType: CapabilityProductType, field: CapabilityField) {
  const dailyField = field === "productApi" ? "productDailySync" : "holdingDailySync";
  return platformCapabilities
    .filter((entry) => entry.accountId === accountId && entry.productType === productType
      && entry[field] !== "unsupported" && entry[dailyField])
    .map((entry) => entry.asset);
}

/** Assets with a known usable endpoint, including scopes not yet in routine sync. */
export function availableApiAssetsFor(accountId: string, productType: CapabilityProductType, field: CapabilityField) {
  return platformCapabilities
    .filter((entry) => entry.accountId === accountId && entry.productType === productType && entry[field] !== "unsupported")
    .map((entry) => entry.asset);
}

/** Public product/APR scopes enabled in routine synchronization. */
export function publicProductAssetsFor(accountId: string, productType: CapabilityProductType) {
  return platformCapabilities
    .filter((entry) => entry.accountId === accountId && entry.productType === productType
      && entry.productApi === "public" && entry.productDailySync)
    .map((entry) => entry.asset);
}

/**
 * Auditable endpoint and zero-inference metadata shared by the capability
 * report and documentation. The endpoint path is intentionally kept separate
 * from credentials, signatures, query parameters and response data.
 */
export function capabilityApiReference(
  accountId: string,
  asset: Asset,
  productType: CapabilityProductType,
  field: CapabilityField,
): CapabilityApiReference {
  const capability = platformCapabilities.find((entry) => (
    entry.accountId === accountId && entry.asset === asset && entry.productType === productType
  ));
  const mode = capability?.[field] ?? "unsupported";
  const isHolding = field === "holdingApi";
  const productDocs = {
    binance: productType === "flexible"
      ? ["https://developers.binance.com/docs/simple_earn/account/Get-Flexible-Product-List"]
      : ["https://developers.binance.com/docs/simple_earn/account/Get-Locked-Product-List"],
    bybit: productType === "flexible"
      ? ["https://bybit-exchange.github.io/docs/v5/finance/earn/easy-onchain/product-info"]
      : ["https://bybit-exchange.github.io/docs/v5/finance/earn/fixed-saving/product"],
    bitget: ["https://www.bitget.com/docs/catalog/earn-classic-savings/classic-earn-savings"],
    okx: ["https://www.okx.com/docs-v5/en/#financial-product"],
    mexc: ["https://www.mexc.com/api-docs/spot-v3/introduction"],
  } as const;
  const holdingDocs = {
    binance: productType === "flexible"
      ? ["https://developers.binance.com/docs/simple_earn/account/Get-Flexible-Product-Position"]
      : ["https://developers.binance.com/docs/simple_earn/account/Get-Locked-Product-Position"],
    bybit: productType === "flexible"
      ? ["https://bybit-exchange.github.io/docs/v5/finance/earn/easy-onchain/position"]
      : ["https://bybit-exchange.github.io/docs/v5/finance/earn/fixed-saving/position"],
    bitget: ["https://www.bitget.com/docs/catalog/earn-classic-savings/classic-earn-savings"],
    okx: ["https://www.okx.com/docs-v5/en/#financial-product-get-savings-balance"],
    mexc: ["https://www.mexc.com/api-docs/spot-v3/introduction"],
  } as const;
  const exchange = capability?.exchange;
  const path = (mode === "unsupported" && exchange !== "bybit") || (accountId === "bybit-eu" && isHolding)
    ? null
    : exchange === "binance"
    ? `/sapi/v1/simple-earn/${productType === "flexible" ? "flexible" : "locked"}/${isHolding ? "position" : "list"}`
    : exchange === "bybit"
      ? productType === "flexible"
        ? isHolding ? "/v5/earn/position" : "/v5/earn/product"
        : isHolding ? "/v5/earn/fixed-term/position" : "/v5/earn/fixed-term/product"
      : exchange === "bitget"
        ? isHolding ? "/api/v2/earn/savings/assets" : "/api/v2/earn/savings/product"
        : exchange === "okx" && isHolding && productType === "flexible"
          ? "/api/v5/finance/savings/balance"
          : null;
  const host = exchange === "binance"
    ? "api-gcp.binance.com (默认；账号地区路由)"
    : exchange === "bybit"
      ? capability?.region === "eu" ? "api.bybit.eu" : "api.bybit.com / api.bytick.com"
      : exchange === "bitget"
        ? "api.bitget.com"
        : exchange === "okx" && path
          ? "openapi.okx.com / www.okx.com"
          : null;
  const permission = mode === "public"
    ? "公开 API，无需账号密钥"
    : mode === "authenticated"
      ? exchange === "binance"
        ? "鉴权 API：API Key + Secret；只读账户权限（USER_DATA），关闭交易/提现权限"
        : exchange === "bitget"
          ? "鉴权 API：API Key + Secret + Passphrase；只读 Savings/资产权限，关闭交易/提现权限"
          : exchange === "bybit"
            ? "鉴权 API：API Key + Secret；需 Earn 持仓只读权限，关闭交易/提现权限"
            : "鉴权 API：API Key + Secret + Passphrase；只读金融产品权限，关闭交易/提现权限"
      : exchange === "bybit" && capability?.region === "eu" && isHolding
        ? "EU Key 当前没有 Earn 持仓权限选项；项目按手动维护"
        : exchange === "bybit" && mode === "unsupported"
          ? "公开 API 已实测拒绝该币种参数；本项目按人工维护"
        : "项目当前没有可用接口；人工维护";
  const docs = exchange
    ? [...(isHolding ? holdingDocs[exchange] : productDocs[exchange])]
    : [];
  let emptyHoldingMeansZero: EmptyHoldingVerdict | null = null;
  let emptyHoldingEvidence: string | null = null;
  if (isHolding) {
    if (mode === "unsupported") {
      emptyHoldingMeansZero = "no";
      emptyHoldingEvidence = exchange === "bybit"
        ? "当前币种没有可用的持仓 API 查询范围；请求不成功时不能把空结果当作零。"
        : "项目没有可用的产品级持仓接口，不能用空结果推断具体产品为零。";
    } else if (exchange === "binance") {
      emptyHoldingMeansZero = "yes";
      emptyHoldingEvidence = "Binance Simple Earn position 接口按活期/定期产品返回产品 ID 与持仓量；请求范围、全部分页和身份字段均完整时，未出现的产品可视为当前持仓为零。请求失败、分页不全或字段无效时不成立。";
    } else if (exchange === "bitget") {
      emptyHoldingMeansZero = "yes";
      emptyHoldingEvidence = "Bitget Savings assets 接口按产品返回币种、期限类型、产品 ID 与持仓量；仅在 endId 分页全部读取且每行身份/金额有效时，未出现的产品可视为当前持仓为零。请求失败、分页不全或字段无效时不成立。";
    } else if (exchange === "bybit" && capability?.region === "global") {
      emptyHoldingMeansZero = "yes";
      emptyHoldingEvidence = productType === "flexible"
        ? "Bybit 官方说明 Flexible Saving 持仓响应含 coin、productId、amount，且已全部赎回的 Flexible Saving position 仍会返回；完整读取 nextPageCursor 的所有页并校验身份/金额后，未出现的产品可视为当前持仓为零。"
        : "Bybit 官方说明定期持仓接口只返回 Active positions（已结算的 position 不返回），且 productId、coin、duration、amount 可逐产品识别；完整读取 nextPageCursor 的所有页并校验身份/金额后，未出现的产品可视为当前无活动持仓。";
    } else if (exchange === "okx") {
      emptyHoldingMeansZero = "yes";
      emptyHoldingEvidence = "OKX Savings balance 按币种汇总且不返回产品 ID；本项目每个受监控币种只跟踪一条活期产品，因此完整成功回包中未出现该币种时按该产品当前持仓为零。仅在 data 为数组、所有返回行币种可识别、受监控币种没有重复行且金额有效时成立；请求失败或响应不完整时不成立。";
    } else {
      emptyHoldingMeansZero = "no";
      emptyHoldingEvidence = exchange === "bybit"
        ? "Bybit EU 当前没有可用 Earn 持仓接口；未配置/无权限不等于零持仓。"
        : "项目没有可用的产品级持仓接口，不能用空结果推断具体产品为零。";
    }
  }
  return {
    method: path ? "GET" : null,
    path,
    host,
    permission,
    officialDocs: docs,
    emptyHoldingMeansZero,
    emptyHoldingEvidence,
  };
}

/**
 * Only scopes whose configured position endpoint is explicitly trusted to
 * represent a complete tracked holding scope may infer zero from absence.
 * The sync route uses this as the same gate for zero updates and catalog
 * archival; API availability or a successful HTTP response alone is not enough.
 */
export function authoritativeEmptyHoldingScopeKeys(completeAccountIds: readonly string[]) {
  const completed = new Set(completeAccountIds);
  return platformCapabilities.flatMap((capability) => {
    if (!completed.has(capability.accountId)
      || !capability.holdingDailySync
      || capability.holdingApi === "unsupported") return [];
    const reference = capabilityApiReference(
      capability.accountId,
      capability.asset,
      capability.productType,
      "holdingApi",
    );
    if (reference.emptyHoldingMeansZero !== "yes") return [];
    return [platformCapabilityScopeKey(capability.accountId, capability.asset, capability.productType)];
  }).filter((key, index, values) => values.indexOf(key) === index);
}
