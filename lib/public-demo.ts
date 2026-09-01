import type { HoldingMap, Product } from "./domain";
import type { ProductOverrideMap } from "./product-overrides";
import { seedProducts } from "./seed-data";

type DemoFacts = Partial<Pick<Product, "productType" | "termDays" | "requiresLiveRate">>;

export const publicDemoProducts: Product[] = [
  demoProduct("bn-g-usdt"),
  demoProduct("bg-usdt-simple"),
  demoProduct("by-g-usdt-short-fixed", [[0, 1000, 4.5]], { productType: "fixed", termDays: 7, requiresLiveRate: false }),
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

function demoProduct(
  id: string,
  tiers?: Array<[number, number | null, number]>,
  facts: DemoFacts = {},
): Product {
  const product = seedProducts.find((candidate) => candidate.id === id);
  if (!product) throw new Error(`Missing seed product: ${id}`);
  return {
    ...product,
    ...facts,
    source: { kind: "demo", label: "演示数据" },
    rateCoverage: "complete",
    tiers: tiers
      ? tiers.map(([min, max, apr], index) => ({ id: `${id}-tier-${index}`, min, max, apr }))
      : product.tiers,
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
