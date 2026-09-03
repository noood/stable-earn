import type { LiveRate } from "@/lib/live-rates";

export function mergeRates(primary: LiveRate[], fallback: LiveRate[]) {
  const merged = new Map(fallback.map((rate) => [rate.productId, rate]));
  for (const rate of primary) merged.set(rate.productId, rate);
  return [...merged.values()];
}
