import type { D1Database } from "@cloudflare/workers-types";
import type { LiveRate } from "@/lib/live-rates";
import { seedProducts } from "@/lib/seed-data";

const productIds = new Set(seedProducts.map((product) => product.id));

export async function saveRateSnapshots(db: D1Database, rates: LiveRate[]) {
  const valid = rates.filter((rate) => productIds.has(rate.productId));
  if (valid.length === 0) return;
  await db.batch(valid.map((rate) => db.prepare(`INSERT INTO rate_snapshots (product_id, payload, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(product_id)
      DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
    .bind(rate.productId, JSON.stringify(rate), rate.fetchedAt)));
}

export async function loadRateSnapshots(db: D1Database) {
  const result = await db.prepare("SELECT payload FROM rate_snapshots ORDER BY product_id").all<{ payload: string }>();
  return result.results.flatMap((row) => {
    try {
      const rate = JSON.parse(row.payload) as LiveRate;
      return productIds.has(rate.productId) && Number.isFinite(rate.apr) ? [rate] : [];
    } catch {
      return [];
    }
  });
}

export function mergeRates(primary: LiveRate[], fallback: LiveRate[]) {
  const merged = new Map(fallback.map((rate) => [rate.productId, rate]));
  for (const rate of primary) merged.set(rate.productId, rate);
  return [...merged.values()];
}
