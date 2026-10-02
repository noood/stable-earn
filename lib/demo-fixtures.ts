import type { Product } from "./domain";
import { createProductTemplate } from "./product-template";

const accountApiReference = { kind: "private" as const, label: "等待账户 API" };
const accountProductApiHolding = { productDataMode: "api" as const, apiAccess: "authenticated" as const, holdingDataMode: "api" as const };

function demoProduct(product: Product): Product {
  return { ...product, source: { kind: "demo", label: "演示数据" }, rateCoverage: "complete" };
}

export const demoProductTemplates: Product[] = [
  demoProduct(createProductTemplate("bn-g-usdt", "binance-global", "binance", "global", "USDT", "Simple Earn Flexible", [[0, 500, 6.2], [500, null, 2.5]], accountApiReference, accountProductApiHolding)),
  demoProduct(createProductTemplate("bg-usdt-simple", "bitget-global", "bitget", "global", "USDT", "Simple Earn", [[0, 300, 6.66], [300, null, 1.3]], { kind: "manual", label: "等待 Bitget 账户 API" }, accountProductApiHolding)),
  demoProduct({ ...createProductTemplate("by-g-usdt-short-fixed", "bybit-global", "bybit", "global", "USDT", "Fixed Saving · 7 天以内", [[0, 1000, 4]], { kind: "private", label: "等待 Bybit 官方固定期限 API" }, accountProductApiHolding), productType: "fixed", termDays: 7 }),
  demoProduct(createProductTemplate("mexc-uk-usdt", "mexc-uk", "mexc", "uk", "USDT", "活期理财", [[0, 1000, 4.8]], { kind: "manual", label: "尚未接入可验证的实时 APR" })),
];
