import type { LiveRate } from "@/lib/live-rates";

const fieldCacheAccounts = new Set([
  "binance-global",
  "binance-bahrain",
  "bybit-global",
  "bybit-eu",
  "bitget-global",
]);

/**
 * Restore only unavailable APR/capacity fields from a previously valid rate
 * for the same account-scoped product identity. An explicit APR of zero and
 * an explicit unlimited final tier are both valid live values.
 */
export function mergeRateFields(primary: LiveRate[], fallback: LiveRate[]) {
  const cachedByIdentity = new Map<string, LiveRate>();
  for (const rate of fallback) {
    const key = scopedIdentityKey(rate);
    if (key && !cachedByIdentity.has(key)) cachedByIdentity.set(key, rate);
  }

  return primary.map((rate) => {
    if (!isFieldCacheAccount(rate)) return rate;
    const key = scopedIdentityKey(rate);
    const cached = key ? cachedByIdentity.get(key) : undefined;
    if (!cached) return rate;

    const merged: LiveRate = { ...rate };
    // Holdings-only adapter rows are shells, not evidence that the existing
    // API product has become manually maintained.
    if (rate.productDataMode === "manual" && cached.productDataMode !== "manual" && cached.catalog) {
      merged.productDataMode = "api";
    }

    const liveAprIsUsable = hasUsableApr(rate);
    const cachedAprIsUsable = hasUsableApr(cached);
    const liveCapacityIsUsable = hasUsableLiveTierCapacity(rate);
    const cachedCapacityIsUsable = hasUsableTierCapacity(cached);
    const compatibleShape = rate.tierStructureStatus !== "incomplete" && sameTierShape(rate, cached);

    if (rate.tierStructureStatus === "incomplete" && cachedAprIsUsable && cachedCapacityIsUsable) {
      // A missing/overlapping tier is not a field-sized failure. The complete
      // old schedule is the only safe fallback until the shape is confirmed.
      copyRatePlan(merged, cached);
      merged.capacitySource = "cache";
      merged.capacityFetchedAt = cacheTimestamp(cached, "capacity");
    }

    if (!liveAprIsUsable && cachedAprIsUsable && merged.aprSource !== "cache") {
      if (liveCapacityIsUsable && compatibleShape) {
        // APR and quota can be merged independently only when both schedules
        // use the same tier boundaries. Keep the current quota and borrow the
        // matching APR values.
        copyAprPlan(merged, cached);
        merged.tiers = rate.tiers?.map((tier, index) => ({
          ...tier,
          apr: cached.tiers![index]!.apr,
        }));
        merged.aprStatus = "available";
      } else {
        // Without a compatible complete shape, an APR tier cannot safely be
        // paired with current quota boundaries. Reuse the cached plan intact.
        copyRatePlan(merged, cached);
        if (cachedCapacityIsUsable) {
          merged.capacitySource = "cache";
          merged.capacityFetchedAt = cacheTimestamp(cached, "capacity");
        } else {
          merged.capacitySource = undefined;
          merged.capacityFetchedAt = undefined;
        }
      }
      merged.aprSource = "cache";
      merged.aprFetchedAt = cacheTimestamp(cached, "apr");
    }

    // A missing/unreadable quota is a separate field failure. Preserve a
    // current APR when the tier structure still aligns with the cached quota.
    if (!liveCapacityIsUsable && cachedCapacityIsUsable && merged.capacitySource !== "cache") {
      if (hasUsableApr(merged) && compatibleShape) {
        merged.tiers = merged.tiers?.map((tier, index) => {
          const restored = { ...tier, max: cached.tiers![index]!.max };
          delete restored.maxStatus;
          if (cached.tiers![index]!.maxStatus) restored.maxStatus = cached.tiers![index]!.maxStatus;
          return restored;
        });
        merged.capacityStatus = "available";
        merged.capacitySource = "cache";
        merged.capacityFetchedAt = cacheTimestamp(cached, "capacity");
      } else if (cachedAprIsUsable) {
        copyRatePlan(merged, cached);
        merged.capacitySource = "cache";
        merged.capacityFetchedAt = cacheTimestamp(cached, "capacity");
      }
    }

    // This scalar is distinct from tier boundaries. An explicit, supported
    // unlimited/limited result always wins; only malformed values may fall
    // back to a prior valid scalar.
    if (rate.subscriptionMaximumStatus === "unreadable"
      && (cached.subscriptionMaximumStatus === "limited" || cached.subscriptionMaximumStatus === "unlimited")) {
      merged.subscriptionMaximum = cached.subscriptionMaximum;
      merged.subscriptionMaximumStatus = cached.subscriptionMaximumStatus;
      merged.subscriptionMaximumSource = "cache";
      merged.subscriptionMaximumFetchedAt = cached.subscriptionMaximumFetchedAt ?? cached.fetchedAt;
    }

    if (hasUsableApr(merged) && hasUsableTierCapacity(merged) && merged.tierStructureStatus !== "incomplete") {
      merged.rateCoverage = "complete";
    }

    return merged;
  });
}

export function mergeRates(primary: LiveRate[], fallback: LiveRate[]) {
  const merged = new Map(fallback.map((rate) => [rate.productId, rate]));
  for (const rate of primary) merged.set(rate.productId, rate);
  return [...merged.values()];
}

function scopedIdentityKey(rate: LiveRate) {
  const accountId = rate.catalog?.accountId;
  // legacyIdentityKey is deliberately excluded: it can omit an identity
  // dimension such as term length (Bybit reuses a raw fixed-term product ID).
  // The canonical identity already includes every stable distinguishing field.
  const identity = rate.identityKey ?? rate.canonicalProductId ?? rate.productId;
  return accountId && identity ? `${accountId}\u0000${identity}` : undefined;
}

function isFieldCacheAccount(rate: LiveRate) {
  return Boolean(rate.catalog?.accountId && fieldCacheAccounts.has(rate.catalog.accountId));
}

function hasUsableApr(rate: LiveRate) {
  if (rate.aprStatus === "unavailable" || rate.rateShape === "no_rate") return false;
  if (rate.aprStatus !== "available" && (rate.rateCoverage === "unavailable" || rate.rateCoverage === "partial")) return false;
  if (!Number.isFinite(rate.apr)) return false;
  return !rate.tiers?.some((tier) => !Number.isFinite(tier.apr));
}

function hasUsableLiveTierCapacity(rate: LiveRate) {
  return rate.capacitySource !== "cache" && hasUsableTierCapacity(rate);
}

function hasUsableTierCapacity(rate: LiveRate) {
  return rate.capacityStatus !== "unavailable" && rate.tierStructureStatus !== "incomplete" && hasCompleteTierCapacity(rate);
}

function hasCompleteTierCapacity(rate: LiveRate) {
  const tiers = rate.tiers ?? [];
  if (!tiers.length || tiers[0]!.min !== 0) return false;
  return tiers.every((tier, index) => {
    if (!Number.isFinite(tier.min) || tier.min < 0) return false;
    const hasFiniteMax = tier.max !== null && Number.isFinite(tier.max) && tier.max >= tier.min;
    const isKnownUnlimited = tier.max === null && tier.maxStatus === "unlimited";
    if (!hasFiniteMax && !isKnownUnlimited) return false;
    if (index === 0) return true;
    return tiers[index - 1]!.max === tier.min;
  }) && rate.tiers!.slice(0, -1).every((tier) => tier.max !== null);
}

function sameTierShape(left: LiveRate, right: LiveRate) {
  return Boolean(left.tiers?.length)
    && left.tiers!.length === right.tiers?.length
    && left.tiers!.every((tier, index) => (
      Number.isFinite(tier.min)
      && tier.min === right.tiers![index]!.min
    ));
}

function copyAprPlan(target: LiveRate, source: LiveRate) {
  target.apr = source.apr;
  target.baseApr = source.baseApr;
  target.bonusTiers = source.bonusTiers;
  target.tierAprs = source.tierAprs;
  target.rateShape = source.rateShape;
  target.aprSource = "cache";
  target.aprFetchedAt = cacheTimestamp(source, "apr");
  target.aprStatus = "available";
}

function copyRatePlan(target: LiveRate, source: LiveRate) {
  copyAprPlan(target, source);
  target.tiers = source.tiers?.map((tier) => ({ ...tier }));
  target.rateCoverage = source.rateCoverage;
  target.capacityStatus = source.capacityStatus;
  target.tierStructureStatus = source.tierStructureStatus;
}

function cacheTimestamp(rate: LiveRate, field: "apr" | "capacity") {
  if (field === "apr" && rate.aprSource === "cache") return rate.aprFetchedAt ?? rate.fetchedAt;
  if (field === "capacity" && rate.capacitySource === "cache") return rate.capacityFetchedAt ?? rate.fetchedAt;
  return rate.fetchedAt;
}
