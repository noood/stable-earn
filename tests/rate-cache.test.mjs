import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

const { mergeRateFields } = moduleLoader()("@/lib/rate-cache");

function rate(overrides = {}) {
  return {
    productId: "binance-global:USDT:flexible:product-1",
    identityKey: "binance-global:USDT:flexible:product-1",
    canonicalProductId: "binance-global:USDT:flexible:product-1",
    productDataMode: "api",
    apr: 8,
    rateShape: "tiered_rate",
    tiers: [{ min: 0, max: 300, apr: 8 }, { min: 300, max: null, apr: 3, maxStatus: "unlimited" }],
    fetchedAt: "2026-10-10T10:00:00.000Z",
    sourceLabel: "API",
    rateCoverage: "complete",
    catalog: { accountId: "binance-global", exchange: "binance", region: "global", asset: "USDT", holdingDataMode: "api", apiAccess: "authenticated" },
    ...overrides,
  };
}

test("missing APR borrows only the cached APR plan when current tier boundaries align", () => {
  const previous = rate({ fetchedAt: "2026-10-09T10:00:00.000Z" });
  const incoming = rate({
    apr: 0,
    rateShape: "no_rate",
    rateCoverage: "unavailable",
    tiers: [{ min: 0, max: 300, apr: 0 }, { min: 300, max: null, apr: 0, maxStatus: "unlimited" }],
  });

  const [merged] = mergeRateFields([incoming], [previous]);
  assert.deepEqual(merged.tiers.map(({ min, max, apr }) => ({ min, max, apr })), [
    { min: 0, max: 300, apr: 8 },
    { min: 300, max: null, apr: 3 },
  ]);
  assert.equal(merged.aprSource, "cache");
  assert.equal(merged.aprFetchedAt, previous.fetchedAt);
  assert.equal(merged.capacitySource, undefined);
  assert.equal(merged.fetchedAt, incoming.fetchedAt);
});

test("missing quota borrows compatible cached boundaries without overwriting a live APR", () => {
  const previous = rate({ fetchedAt: "2026-10-09T10:00:00.000Z", capacitySource: "live", capacityFetchedAt: "2026-10-09T10:00:00.000Z" });
  const incoming = rate({
    apr: 7,
    tiers: [{ min: 0, max: null, apr: 7 }, { min: 300, max: null, apr: 2, maxStatus: "unlimited" }],
    rateCoverage: "base_only",
  });

  const [merged] = mergeRateFields([incoming], [previous]);
  assert.deepEqual(merged.tiers.map(({ min, max, apr }) => ({ min, max, apr })), [
    { min: 0, max: 300, apr: 7 },
    { min: 300, max: null, apr: 2 },
  ]);
  assert.equal(merged.apr, 7);
  assert.equal(merged.aprSource, undefined);
  assert.equal(merged.capacitySource, "cache");
  assert.equal(merged.capacityFetchedAt, previous.fetchedAt);
  assert.equal(merged.rateCoverage, "complete");
});

test("a holdings-only row keeps the established API source and can recover cached APR and quota", () => {
  const previous = rate({ fetchedAt: "2026-10-09T10:00:00.000Z" });
  const holdingOnly = rate({
    productDataMode: "manual",
    apr: 0,
    rateShape: "no_rate",
    rateCoverage: "unavailable",
    tiers: [],
    sourceLabel: "持仓 API",
  });

  const [merged] = mergeRateFields([holdingOnly], [previous]);
  assert.equal(merged.productDataMode, "api");
  assert.equal(merged.rateCoverage, "complete");
  assert.equal(merged.apr, 8);
  assert.equal(merged.aprSource, "cache");
  assert.equal(merged.capacitySource, "cache");
  assert.equal(merged.aprFetchedAt, previous.fetchedAt);
  assert.equal(merged.capacityFetchedAt, previous.fetchedAt);
});

test("a default-API cached adapter row is not downgraded by a holdings-only shell", () => {
  const previous = rate({ productDataMode: undefined });
  const incoming = rate({ productDataMode: "manual", aprStatus: "unavailable", capacityStatus: "unavailable",
    apr: 0, rateShape: "no_rate", rateCoverage: "unavailable", tiers: [] });
  const [merged] = mergeRateFields([incoming], [previous]);
  assert.equal(merged.productDataMode, "api");
  assert.equal(merged.apr, 8);
  assert.equal(merged.aprSource, "cache");
});

test("explicit zero APR and unlimited quota win over cached values", () => {
  const previous = rate({ fetchedAt: "2026-10-09T10:00:00.000Z" });
  const incoming = rate({
    apr: 0,
    tiers: [{ min: 0, max: null, apr: 0, maxStatus: "unlimited" }],
    rateShape: "single_rate",
    rateCoverage: "complete",
  });

  const [merged] = mergeRateFields([incoming], [previous]);
  assert.equal(merged.apr, 0);
  assert.equal(merged.tiers[0].max, null);
  assert.equal(merged.tiers[0].maxStatus, "unlimited");
  assert.equal(merged.aprSource, undefined);
  assert.equal(merged.capacitySource, undefined);
});

test("identity mismatches and unsupported accounts do not borrow cache", () => {
  const previous = rate({ fetchedAt: "2026-10-09T10:00:00.000Z" });
  const mismatched = rate({ identityKey: "binance-global:USDT:flexible:other", canonicalProductId: "binance-global:USDT:flexible:other", productId: "binance-global:USDT:flexible:other" });
  const okx = rate({ catalog: { ...previous.catalog, accountId: "okx-global", exchange: "okx" } });

  assert.equal(mergeRateFields([mismatched], [previous])[0].aprSource, undefined);
  assert.equal(mergeRateFields([okx], [previous])[0].aprSource, undefined);
});

test("Bybit fixed products sharing a legacy raw ID never share cached APR or quota across terms", () => {
  const sevenDay = rate({
    productId: "bybit-global:USDT:fixed:4@7d",
    identityKey: "bybit-global:USDT:fixed:4@7d",
    canonicalProductId: "bybit-global:USDT:fixed:4@7d",
    legacyIdentityKey: "bybit-global:USDT:fixed:4",
    productType: "fixed",
    termDays: 7,
    tiers: [{ min: 0, max: 100, apr: 9 }],
  });
  const ninetyDay = rate({
    productId: "bybit-global:USDT:fixed:4@90d",
    identityKey: "bybit-global:USDT:fixed:4@90d",
    canonicalProductId: "bybit-global:USDT:fixed:4@90d",
    legacyIdentityKey: "bybit-global:USDT:fixed:4",
    productType: "fixed",
    termDays: 90,
    apr: 0,
    rateShape: "no_rate",
    rateCoverage: "unavailable",
    tiers: [],
  });

  const [merged] = mergeRateFields([ninetyDay], [sevenDay]);
  assert.equal(merged.apr, 0);
  assert.equal(merged.aprSource, undefined);
  assert.equal(merged.capacitySource, undefined);
});

test("all five supported accounts retain a live zero when only quota is unreadable", () => {
  for (const accountId of ["binance-global", "binance-bahrain", "bybit-global", "bybit-eu", "bitget-global"]) {
    const identityKey = `${accountId}:USDT:fixed:one@7d`;
    const previous = rate({ productId: identityKey, identityKey, canonicalProductId: identityKey,
      catalog: { ...rate().catalog, accountId }, fetchedAt: "2026-10-09T10:00:00.000Z",
      rateShape: "single_rate", tiers: [{ min: 0, max: 300, apr: 8 }],
      subscriptionMaximum: 300, subscriptionMaximumStatus: "limited" });
    const incoming = { ...previous, fetchedAt: "2026-10-10T10:00:00.000Z", apr: 0,
      aprStatus: "available", capacityStatus: "unavailable", tierStructureStatus: "complete",
      rateCoverage: "partial", tiers: [{ min: 0, max: null, apr: 0 }],
      subscriptionMaximum: null, subscriptionMaximumStatus: "unreadable" };
    const [merged] = mergeRateFields([incoming], [previous]);
    assert.equal(merged.apr, 0, accountId);
    assert.equal(merged.tiers[0].apr, 0, accountId);
    assert.equal(merged.tiers[0].max, 300, accountId);
    assert.equal(merged.aprSource, undefined, accountId);
    assert.equal(merged.capacitySource, "cache", accountId);
    assert.equal(merged.capacityFetchedAt, previous.fetchedAt, accountId);
    assert.equal(merged.subscriptionMaximumSource, "cache", accountId);
    assert.equal(merged.rateCoverage, "complete", accountId);
  }
});

test("a structural gap uses the full cached plan instead of splicing live APRs", () => {
  const previous = rate({ fetchedAt: "2026-10-09T10:00:00.000Z" });
  const incoming = rate({ apr: 9, aprStatus: "available", capacityStatus: "unavailable", tierStructureStatus: "incomplete",
    tiers: [{ min: 0, max: 300, apr: 9 }, { min: 400, max: null, apr: 4, maxStatus: "unlimited" }], rateCoverage: "partial" });
  const [merged] = mergeRateFields([incoming], [previous]);
  assert.deepEqual(merged.tiers, previous.tiers);
  assert.equal(merged.apr, 8);
  assert.equal(merged.aprSource, "cache");
  assert.equal(merged.capacitySource, "cache");
  assert.equal(merged.rateCoverage, "complete");
  assert.equal(mergeRateFields([incoming], [])[0].tierStructureStatus, "incomplete");
});

test("a missing APR preserves changed live single-tier capacity and the original APR cache time", () => {
  const previous = rate({ fetchedAt: "2026-10-09T10:00:00.000Z", aprSource: "cache", aprFetchedAt: "2026-10-08T10:00:00.000Z",
    rateShape: "single_rate", tiers: [{ min: 0, max: 300, apr: 8 }] });
  const incoming = rate({ apr: 0, aprStatus: "unavailable", capacityStatus: "available", tierStructureStatus: "complete",
    rateShape: "no_rate", rateCoverage: "unavailable", tiers: [{ min: 0, max: 500, apr: 0 }] });
  const [merged] = mergeRateFields([incoming], [previous]);
  assert.equal(merged.tiers[0].max, 500);
  assert.equal(merged.apr, 8);
  assert.equal(merged.capacitySource, undefined);
  assert.equal(merged.aprFetchedAt, "2026-10-08T10:00:00.000Z");
  assert.equal(merged.rateCoverage, "complete");
});
