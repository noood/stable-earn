import type { HoldingMap, Product, ProductChangeEvent } from "./domain";
import type { ProductOverrideMap } from "./product-overrides";
import { demoProductTemplates } from "./demo-fixtures";

type DemoFacts = Partial<Pick<Product, "productType" | "termDays">>;

export const publicDemoProducts: Product[] = [
  demoProduct("bn-g-usdt"),
  demoProduct("bg-usdt-simple"),
  demoProduct("by-g-usdt-short-fixed", [[0, 1000, 4.5]], { productType: "fixed", termDays: 7 }),
  demoProduct("mexc-uk-usdt", [[0, 1000, 4.8]]),
];

export const publicDemoHoldings: HoldingMap = {
  "bn-g-usdt": 650,
  "bg-usdt-simple": 180,
  "by-g-usdt-short-fixed": 100,
  "mexc-uk-usdt": 0,
};

export const publicDemoOverrides: ProductOverrideMap = {
  "by-g-usdt-short-fixed": demoOverride({ purchaseDate: "2026-08-29" }),
};

// Synthetic, fixed examples for the signed-out page; never sourced from user history.
export const publicDemoChangeEvents: ProductChangeEvent[] = [
  {
    id: "demo-change-bn-usdt-rate",
    productId: "bn-g-usdt",
    type: "rate",
    title: "首档 APR 下调",
    before: "6.80%",
    after: "6.20%",
    observedAt: "2026-10-05T10:30:00.000Z",
    source: "手动刷新",
  },
  {
    id: "demo-change-bn-usdt-capacity",
    productId: "bn-g-usdt",
    type: "capacity",
    title: "首档额度减少",
    before: "700 USDT",
    after: "500 USDT",
    observedAt: "2026-10-04T10:30:00.000Z",
    source: "每日首次打开",
  },
];

function demoProduct(
  id: string,
  tiers?: Array<[number, number | null, number]>,
  facts: DemoFacts = {},
): Product {
  const product = demoProductTemplates.find((candidate) => candidate.id === id);
  if (!product) throw new Error(`Missing demo product: ${id}`);
  return {
    ...product,
    ...facts,
    source: { kind: "demo", label: "演示数据" },
    rateCoverage: "complete",
    tiers: tiers
      ? tiers.map(([min, max, apr], index) => ({ id: `${id}-tier-${index}`, min, max, apr, ...(max === null ? { maxStatus: "unlimited" as const } : {}) }))
      : product.tiers.map((tier) => tier.max === null ? { ...tier, maxStatus: "unlimited" as const } : tier),
  };
}

function demoOverride(values: Partial<ProductOverrideMap[string]>): ProductOverrideMap[string] {
  return {
    apr: null,
    firstTierLimit: null,
    termDays: null,
    purchaseDate: null,
    updatedAt: null,
    ...values,
  };
}
