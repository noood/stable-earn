import type { Product, ProductDataSource } from "./domain";
import { buildManualProductIdentity } from "./product-identity";

const manualProductManualHolding = { productDataMode: "manual" as const, holdingDataMode: "manual" as const };

export function createProductTemplate(
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
    identityKey: dataMode.productDataMode === "manual"
      ? buildManualProductIdentity({ accountId, asset, productType: "flexible", slug: "default" })
      : id,
    tiers: tiers.map(([min, max, apr], index) => ({ id: `${id}-tier-${index}`, min, max, apr })),
  };
}
