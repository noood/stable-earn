import type { Product } from "./domain";
import { createProductTemplate } from "./product-template";

// OKX's balance endpoint still returns these legacy product IDs. Keep only
// these production compatibility templates here; demo and preview fixtures
// live in their own modules and never seed an authenticated catalogue.
const manualProductApiHolding = { productDataMode: "manual" as const, holdingDataMode: "api" as const };

export const catalogProductTemplates: Product[] = [
  ...(["USDT", "USDC", "BTC"] as const).map((asset) => ({
    ...createProductTemplate(`okx-${asset.toLowerCase()}`, "okx-global", "okx", "global", asset, "Simple Earn", [[0, null, 0]], { kind: "manual", label: "产品信息需人工确认" }, manualProductApiHolding),
    rateCoverage: "unavailable" as const,
    productTypeStatus: "missing" as const,
  })),
];
