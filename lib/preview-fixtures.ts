import type { Product } from "./domain";
import { createProductTemplate } from "./product-template";

const manual = { kind: "manual" as const, label: "配置示例" };
const accountApiReference = { kind: "private" as const, label: "等待账户 API" };
const publicProductApiHolding = { productDataMode: "api" as const, apiAccess: "public" as const, holdingDataMode: "api" as const };
const publicProductManualHolding = { productDataMode: "api" as const, apiAccess: "public" as const, holdingDataMode: "manual" as const };
const accountProductApiHolding = { productDataMode: "api" as const, apiAccess: "authenticated" as const, holdingDataMode: "api" as const };
const manualProductManualHolding = { productDataMode: "manual" as const, holdingDataMode: "manual" as const };

// These products are deliberately limited to local preview and test scenarios.
// They are not production catalogue defaults and are never inserted into D1.
export const previewProducts: Product[] = [
  createProductTemplate("bn-g-usdt", "binance-global", "binance", "global", "USDT", "Simple Earn Flexible", [[0, 500, 6.2], [500, null, 2.5]], accountApiReference, accountProductApiHolding),
  createProductTemplate("bn-g-usdc", "binance-global", "binance", "global", "USDC", "Simple Earn Flexible", [[0, 200, 5.8], [200, null, 2.2]], accountApiReference, accountProductApiHolding),
  createProductTemplate("bn-bh-usdt", "binance-bahrain", "binance", "bahrain", "USDT", "Simple Earn Flexible", [[0, 500, 6.2], [500, null, 2.5]], accountApiReference, accountProductApiHolding),
  createProductTemplate("bn-bh-usdc", "binance-bahrain", "binance", "bahrain", "USDC", "Simple Earn Flexible", [[0, 200, 5.8], [200, null, 2.2]], accountApiReference, accountProductApiHolding),
  { ...createProductTemplate("by-g-usdt-short-fixed", "bybit-global", "bybit", "global", "USDT", "Fixed Saving · 7 天以内", [[0, 1000, 4]], { kind: "private", label: "等待 Bybit 官方固定期限 API" }, accountProductApiHolding), productType: "fixed", termDays: 7 },
  createProductTemplate("by-g-usdc", "bybit-global", "bybit", "global", "USDC", "Easy Earn Flexible", [[0, null, 3.8]], manual, publicProductApiHolding),
  createProductTemplate("by-eu-usdt", "bybit-eu", "bybit", "eu", "USDT", "Easy Earn Flexible", [[0, null, 3.5]], manual, publicProductManualHolding),
  { ...createProductTemplate("by-g-btc-3d", "bybit-global", "bybit", "global", "BTC", "Fixed Saving · 7 天以内", [[0, 1, 4]], { kind: "private", label: "等待 Bybit 官方固定期限 API" }, accountProductApiHolding), productType: "fixed", termDays: 7, minimumAmount: 0.001 },
  createProductTemplate("bg-usdt-simple", "bitget-global", "bitget", "global", "USDT", "Simple Earn", [[0, 300, 6.66], [300, null, 1.3]], { kind: "manual", label: "等待 Bitget 账户 API" }, accountProductApiHolding),
  createProductTemplate("bg-usdc", "bitget-global", "bitget", "global", "USDC", "Simple Earn", [[0, 300, 6.66], [300, 1000000, 1.75]], { kind: "manual", label: "等待 Bitget 账户 API" }, accountProductApiHolding),
  { ...createProductTemplate("bg-usdgo", "bitget-global", "bitget", "global", "USDGO", "Simple Earn Flexible", [[0, null, 6.13]], { kind: "manual", label: "手动维护" }, manualProductManualHolding), rateCoverage: "unavailable" },
  { ...createProductTemplate("mexc-ph-usdt", "mexc-ph", "mexc", "philippines", "USDT", "活期理财", [[0, null, 0]], { kind: "manual", label: "尚未接入可验证的实时 APR" }), rateCoverage: "unavailable" },
  { ...createProductTemplate("mexc-ph-usdc", "mexc-ph", "mexc", "philippines", "USDC", "活期理财", [[0, null, 0]], { kind: "manual", label: "尚未接入可验证的实时 APR" }), rateCoverage: "unavailable" },
  { ...createProductTemplate("okx-usdt", "okx-global", "okx", "global", "USDT", "Simple Earn Flexible", [[0, null, 0]], { kind: "manual", label: "活动信息需人工确认" }, { productDataMode: "manual", holdingDataMode: "api" }), rateCoverage: "unavailable", manualFields: { termDays: true } },
  { ...createProductTemplate("okx-usdc", "okx-global", "okx", "global", "USDC", "Simple Earn Flexible", [[0, null, 0]], { kind: "manual", label: "活动信息需人工确认" }, { productDataMode: "manual", holdingDataMode: "api" }), rateCoverage: "unavailable", manualFields: { termDays: true } },
  { ...createProductTemplate("okx-btc", "okx-global", "okx", "global", "BTC", "Simple Earn Flexible", [[0, null, 0]], { kind: "manual", label: "活动信息需人工确认" }, { productDataMode: "manual", holdingDataMode: "api" }), rateCoverage: "unavailable", manualFields: { termDays: true } },
];
