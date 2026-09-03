import type { Account, Product, ProductDataSource } from "./domain";

export const accounts: Account[] = [
  { id: "binance-global", exchange: "binance", region: "global", name: "Binance.com", mark: "BN", color: "#f0b90b" },
  { id: "binance-bahrain", exchange: "binance", region: "bahrain", name: "Binance Bahrain", mark: "BH", color: "#f0b90b" },
  { id: "bybit-global", exchange: "bybit", region: "global", name: "Bybit.com", mark: "BY", color: "#f7a600" },
  { id: "bybit-eu", exchange: "bybit", region: "eu", name: "Bybit EU", mark: "EU", color: "#f7a600" },
  { id: "bitget-global", exchange: "bitget", region: "global", name: "Bitget", mark: "BG", color: "#0bbfd0" },
  { id: "okx-global", exchange: "okx", region: "global", name: "OKX", mark: "OX", color: "#111111", foreground: "#ffffff" },
  { id: "mexc-ph", exchange: "mexc", region: "philippines", name: "MEXC · PH 🇵🇭", mark: "PH", color: "#00a9df", foreground: "#ffffff" },
  { id: "mexc-uk", exchange: "mexc", region: "uk", name: "MEXC · UK 🇬🇧", mark: "UK", color: "#00a9df", foreground: "#ffffff" },
];

const manual = { kind: "manual" as const, label: "配置示例" };
const accountApiReference = { kind: "private" as const, label: "等待账户 API" };
const publicProductApiHolding = { productDataMode: "api" as const, apiAccess: "public" as const, holdingDataMode: "api" as const };
const publicProductManualHolding = { productDataMode: "api" as const, apiAccess: "public" as const, holdingDataMode: "manual" as const };
const accountProductApiHolding = { productDataMode: "api" as const, apiAccess: "authenticated" as const, holdingDataMode: "api" as const };
const manualProductManualHolding = { productDataMode: "manual" as const, holdingDataMode: "manual" as const };

export const seedProducts: Product[] = [
  product("bn-g-usdt", "binance-global", "binance", "global", "USDT", "Simple Earn Flexible", [[0, 500, 6.2], [500, null, 2.5]], accountApiReference, accountProductApiHolding),
  product("bn-g-usdc", "binance-global", "binance", "global", "USDC", "Simple Earn Flexible", [[0, 200, 5.8], [200, null, 2.2]], accountApiReference, accountProductApiHolding),
  product("bn-bh-usdt", "binance-bahrain", "binance", "bahrain", "USDT", "Simple Earn Flexible", [[0, 500, 6.2], [500, null, 2.5]], accountApiReference, accountProductApiHolding),
  product("bn-bh-usdc", "binance-bahrain", "binance", "bahrain", "USDC", "Simple Earn Flexible", [[0, 200, 5.8], [200, null, 2.2]], accountApiReference, accountProductApiHolding),
  { ...product("by-g-usdt", "bybit-global", "bybit", "global", "USDT", "Easy Earn Flexible", [[0, null, 0]], { kind: "manual", label: "奖励信息需人工确认" }, { productDataMode: "manual", holdingDataMode: "api" }), rateCoverage: "unavailable" },
  { ...product("by-g-usdt-short-fixed", "bybit-global", "bybit", "global", "USDT", "Fixed Saving · 7 天以内", [[0, 1000, 4]], { kind: "private", label: "等待 Bybit 官方固定期限 API" }, accountProductApiHolding), productType: "fixed", termDays: 7, requiresLiveRate: true },
  product("by-g-usdc", "bybit-global", "bybit", "global", "USDC", "Easy Earn Flexible", [[0, null, 3.8]], manual, publicProductApiHolding),
  product("by-eu-usdt", "bybit-eu", "bybit", "eu", "USDT", "Easy Earn Flexible", [[0, null, 3.5]], manual, publicProductManualHolding),
  { ...product("by-eu-usdc", "bybit-eu", "bybit", "eu", "USDC", "Rewards Service Flexible", [[0, null, 0]], { kind: "manual", label: "奖励信息需人工确认" }, manualProductManualHolding), rateCoverage: "unavailable" },
  { ...product("by-g-btc-3d", "bybit-global", "bybit", "global", "BTC", "Fixed Saving · 7 天以内", [[0, 1, 4]], { kind: "private", label: "等待 Bybit 官方固定期限 API" }, accountProductApiHolding), productType: "fixed", termDays: 7, minimumAmount: 0.001, requiresLiveRate: true },
  product("bg-usdt-simple", "bitget-global", "bitget", "global", "USDT", "Simple Earn", [[0, 300, 6.66], [300, null, 1.3]], { kind: "manual", label: "等待 Bitget 账户 API" }, accountProductApiHolding),
  product("bg-usdc", "bitget-global", "bitget", "global", "USDC", "Simple Earn", [[0, 300, 6.66], [300, 1000000, 1.75]], { kind: "manual", label: "等待 Bitget 账户 API" }, accountProductApiHolding),
  { ...product("bg-usdgo", "bitget-global", "bitget", "global", "USDGO", "Simple Earn Flexible", [[0, null, 6.13]], { kind: "manual", label: "手动维护" }, manualProductManualHolding), rateCoverage: "unavailable" },
  { ...product("okx-usdt", "okx-global", "okx", "global", "USDT", "Simple Earn Flexible", [[0, null, 0]], { kind: "manual", label: "活动信息需人工确认" }, { productDataMode: "manual", holdingDataMode: "api" }), rateCoverage: "unavailable", manualFields: { termDays: true } },
  { ...product("okx-usdc", "okx-global", "okx", "global", "USDC", "Simple Earn Flexible", [[0, null, 0]], { kind: "manual", label: "活动信息需人工确认" }, { productDataMode: "manual", holdingDataMode: "api" }), rateCoverage: "unavailable", manualFields: { termDays: true } },
  { ...product("okx-btc", "okx-global", "okx", "global", "BTC", "Simple Earn Flexible", [[0, null, 0]], { kind: "manual", label: "活动信息需人工确认" }, { productDataMode: "manual", holdingDataMode: "api" }), rateCoverage: "unavailable", manualFields: { termDays: true } },
  { ...product("mexc-ph-usdt", "mexc-ph", "mexc", "philippines", "USDT", "活期理财", [[0, null, 0]], { kind: "manual", label: "尚未接入可验证的实时 APR" }), rateCoverage: "unavailable" },
  { ...product("mexc-ph-usdc", "mexc-ph", "mexc", "philippines", "USDC", "活期理财", [[0, null, 0]], { kind: "manual", label: "尚未接入可验证的实时 APR" }), rateCoverage: "unavailable" },
  { ...product("mexc-ph-btc", "mexc-ph", "mexc", "philippines", "BTC", "活期理财", [[0, null, 0]], { kind: "manual", label: "尚未接入可验证的实时 APR" }), rateCoverage: "unavailable" },
  { ...product("mexc-uk-usdt", "mexc-uk", "mexc", "uk", "USDT", "活期理财", [[0, null, 0]], { kind: "manual", label: "尚未接入可验证的实时 APR" }), rateCoverage: "unavailable" },
  { ...product("mexc-uk-usdc", "mexc-uk", "mexc", "uk", "USDC", "活期理财", [[0, null, 0]], { kind: "manual", label: "尚未接入可验证的实时 APR" }), rateCoverage: "unavailable" },
  { ...product("mexc-uk-btc", "mexc-uk", "mexc", "uk", "BTC", "活期理财", [[0, null, 0]], { kind: "manual", label: "尚未接入可验证的实时 APR" }), rateCoverage: "unavailable" },
];

// These records are templates for normalizing live API results and building
// local/demo scenarios. They are never sufficient, by themselves, to admit a
// product into an authenticated user's catalogue.
export const catalogProductTemplates = seedProducts.filter((product) => product.id !== "by-eu-usdc");

function product(
  id: string,
  accountId: string,
  exchange: Product["exchange"],
  region: Product["region"],
  asset: Product["asset"],
  name: string,
  tiers: Array<[number, number | null, number]>,
  source: Product["source"],
  dataMode: ProductDataSource & Pick<Product, "holdingDataMode"> = manualProductManualHolding,
): Product {
  return {
    id, accountId, exchange, region, asset, name, productType: "flexible", source, rateCoverage: "complete", ...dataMode,
    identityKey: id,
    tiers: tiers.map(([min, max, apr], index) => ({ id: `${id}-tier-${index}`, min, max, apr })),
  };
}
