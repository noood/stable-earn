import type { D1Database } from "@cloudflare/workers-types";
import { catalogProductsFromRows, prepareCatalogProductsRead } from "./product-catalog";
import { prepareUserProductsRead, userProductsFromRows, type UserProductRow } from "./user-products";

type AmountRow = { product_id: string; amount: number };
type HiddenRow = { product_id: string };
type OverrideRow = {
  product_id: string;
  confirmed_apr: number | null;
  purchase_date: string | null;
  product_kind_override: "flexible" | "fixed" | "limited" | null;
  updated_at: string;
  first_tier_limit: number | null;
  first_tier_unlimited: number | null;
  term_days: number | null;
};

/** One read-only D1 batch keeps account data together and avoids separate RPCs. */
export async function loadPrivateHoldingsSnapshot(db: D1Database, userId: string) {
  const results = await db.batch([
    prepareCatalogProductsRead(db, userId),
    prepareUserProductsRead(db, userId),
    db.prepare("SELECT product_id, amount FROM holdings WHERE user_id = ? ORDER BY product_id").bind(userId),
    db.prepare(`SELECT product_id, SUM(amount) AS amount FROM holding_positions
      WHERE user_id = ? GROUP BY product_id ORDER BY product_id`).bind(userId),
    db.prepare(`SELECT o.product_id, o.confirmed_apr, o.purchase_date, o.product_kind_override,
        o.updated_at, l.first_tier_limit, l.first_tier_unlimited, t.term_days
      FROM product_overrides o
      LEFT JOIN product_override_limits l ON l.user_id = o.user_id AND l.product_id = o.product_id
      LEFT JOIN product_override_terms t ON t.user_id = o.user_id AND t.product_id = o.product_id
      WHERE o.user_id = ? ORDER BY o.product_id`).bind(userId),
    db.prepare("SELECT product_id FROM hidden_seed_products WHERE user_id = ? ORDER BY product_id").bind(userId),
    db.prepare("SELECT product_id FROM hidden_products WHERE user_id = ? ORDER BY product_id").bind(userId),
    // Only these fields participate in the positive-position hiding guard.
    // Invalid/old cache payloads must retain the former unknown-data fallback.
    db.prepare(`SELECT CASE WHEN json_valid(payload) THEN json_object(
        'holdingUpdates', json_extract(payload, '$.holdingUpdates'),
        'holdingSyncStates', json_extract(payload, '$.holdingSyncStates'),
        'holdingFallbacks', json_extract(payload, '$.holdingFallbacks')) ELSE NULL END AS payload
      FROM sync_snapshots WHERE owner_id = ? AND cache_key = 'private-products'`).bind(userId),
  ]);
  function rows<T>(index: number) {
    const result = results[index];
    if (!result?.success || !Array.isArray(result.results)) throw new Error("private holdings snapshot unavailable");
    return result.results as T[];
  }
  return {
    catalogProducts: catalogProductsFromRows(rows<{ payload: string }>(0)),
    manualProducts: userProductsFromRows(rows<UserProductRow>(1)),
    holdingRows: rows<AmountRow>(2),
    positionRows: rows<AmountRow>(3),
    overrideRows: rows<OverrideRow>(4),
    hiddenSeedRows: rows<HiddenRow>(5),
    hiddenCatalogRows: rows<HiddenRow>(6),
    syncSnapshotPayload: rows<{ payload: string | null }>(7)[0]?.payload,
  };
}
