import type { Product } from "./domain";
import { createProductTemplate } from "./product-template";

// OKX's balance endpoint still returns these legacy product IDs. Keep only
// these production compatibility templates here; demo and preview fixtures
// live in their own modules and never seed an authenticated catalogue.
const manualProductApiHolding = { productDataMode: "manual" as const, holdingDataMode: "api" as const };

export const catalogProductTemplates: Product[] = [
  { ...createProductTemplate("okx-usdt", "okx-global", "okx", "global", "USDT", "Simple Earn Flexible", [[0, null, 0]], { kind: "manual", label: "活动信息需人工确认" }, manualProductApiHolding), rateCoverage: "unavailable", manualFields: { termDays: true } },
  { ...createProductTemplate("okx-usdc", "okx-global", "okx", "global", "USDC", "Simple Earn Flexible", [[0, null, 0]], { kind: "manual", label: "活动信息需人工确认" }, manualProductApiHolding), rateCoverage: "unavailable", manualFields: { termDays: true } },
  { ...createProductTemplate("okx-btc", "okx-global", "okx", "global", "BTC", "Simple Earn Flexible", [[0, null, 0]], { kind: "manual", label: "活动信息需人工确认" }, manualProductApiHolding), rateCoverage: "unavailable", manualFields: { termDays: true } },
];
