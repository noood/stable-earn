import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

const credentials = { apiKey: "test-key", apiSecret: "test-secret", passphrase: "test-pass", baseUrls: ["https://api.bybit.com"] };
const oldTime = "2026-10-09T00:00:00.000Z";

function exchangeLoader(responseFor) {
  return moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({ ok: true, status: 200, headers: new Headers(), url }),
      readExchangeJson: async (response) => responseFor(new URL(response.url)),
      readExchangeText: async (response) => JSON.stringify(responseFor(new URL(response.url))),
      logExchangePayload: () => {},
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
}

async function existingCatalog(load, snapshot) {
  const db = sqliteDb();
  const { prepareProductCatalogSync } = load("@/lib/product-catalog");
  snapshot.rates.forEach((rate) => { rate.fetchedAt = oldTime; });
  const first = await prepareProductCatalogSync(db, "test-user", snapshot.rates, snapshot.holdings, [snapshot.rates[0].catalog.accountId]);
  await db.batch(first.statements);
  assert.equal(first.products.length, 1);
  return { db, first, prepareProductCatalogSync };
}

test("Bitget bad APR with a stable ID reaches cache and catalogue even without any holding", async () => {
  let apy = "8";
  let max = "300";
  const load = exchangeLoader((url) => url.pathname.endsWith("/savings/assets")
    ? { code: "00000", data: { resultList: [], endId: "" } }
    : { code: "00000", data: [{ productId: "offer", coin: "USDT", periodType: "flexible", apyType: "single", status: "available", apyList: [{ minStepVal: "0", maxStepVal: max, currentApy: apy }] }] });
  const { fetchBitgetSavingsSnapshot } = load("@/lib/integrations/bitget");
  const { mergeRateFields } = load("@/lib/rate-cache");
  const initial = await fetchBitgetSavingsSnapshot(credentials, ["USDT"]);
  const { db, first, prepareProductCatalogSync } = await existingCatalog(load, initial);
  apy = "8abc";
  max = "500";
  const next = await fetchBitgetSavingsSnapshot(credentials, ["USDT"]);
  assert.equal(next.sync.productStatus, "complete");
  assert.equal(next.rates.length, 1);
  assert.equal(next.rates[0].aprStatus, "unavailable");
  assert.equal(next.rates[0].capacityStatus, "available");
  const rates = mergeRateFields(next.rates, first.rates);
  assert.equal(rates[0].apr, 8);
  assert.equal(rates[0].tiers[0].max, 500);
  assert.equal(rates[0].aprSource, "cache");
  assert.equal(rates[0].aprFetchedAt, oldTime);
  assert.notEqual(rates[0].capacitySource, "cache");
  const second = await prepareProductCatalogSync(db, "test-user", rates, next.holdings, ["bitget-global"]);
  await db.batch(second.statements);
  assert.equal(second.products[0].id, first.products[0].id);
  assert.equal(second.products[0].tiers[0].max, 500);
  assert.equal(db.sqlite.prepare("SELECT status FROM product_catalog WHERE product_id = ?").get(first.products[0].id).status, "active");
  // Without a valid rate cache, unknown APR still cannot prove the existing
  // product is below the opportunity threshold and must not archive it.
  const uncached = await prepareProductCatalogSync(db, "test-user", next.rates, next.holdings, ["bitget-global"]);
  assert.equal(uncached.products.length, 1);
  assert.equal(uncached.products[0].rateCoverage, "unavailable");
  db.sqlite.close();
});

for (const productType of ["flexible", "fixed"]) {
  test(`Bitget ${productType} uses a live zero APR and only restores an unreadable quota`, async () => {
    let apy = "8";
    let max = "300";
    const load = exchangeLoader((url) => url.pathname.endsWith("/savings/assets")
      ? { code: "00000", data: { resultList: [{ productId: "offer", productCoin: "USDT", periodType: productType, period: "7", holdAmount: "20" }], endId: "" } }
      : { code: "00000", data: [{ productId: "offer", coin: "USDT", periodType: productType, period: "7", apyType: "single", status: "available", apyList: [{ minStepVal: "0", maxStepVal: max, currentApy: apy }] }] });
    const adapter = load("@/lib/integrations/bitget");
    const fetch = productType === "fixed" ? adapter.fetchBitgetFixedSnapshot : adapter.fetchBitgetSavingsSnapshot;
    const { mergeRateFields } = load("@/lib/rate-cache");
    const { productParticipatesInInterest } = load("@/lib/product-status");
    const { rateHeadlineFor } = load("@/lib/product-rate-presentation");
    const initial = await fetch(credentials, ["USDT"]);
    const { db, first, prepareProductCatalogSync } = await existingCatalog(load, initial);
    apy = "0";
    max = "invalid";
    const next = await fetch(credentials, ["USDT"]);
    const rates = mergeRateFields(next.rates, first.rates);
    assert.equal(next.sync.products, true);
    assert.equal(next.rates[0].aprStatus, "available");
    assert.equal(next.rates[0].capacityStatus, "unavailable");
    assert.equal(rates[0].apr, 0);
    assert.notEqual(rates[0].aprSource, "cache");
    assert.equal(rates[0].tiers[0].max, 300);
    assert.equal(rates[0].capacitySource, "cache");
    assert.equal(rates[0].capacityFetchedAt, oldTime);
    assert.equal(rates[0].rateCoverage, "complete");
    const second = await prepareProductCatalogSync(db, "test-user", rates, next.holdings, ["bitget-global"]);
    assert.equal(second.products[0].id, first.products[0].id);
    assert.equal(second.products[0].capacitySource, "cache");
    assert.equal(rateHeadlineFor(second.products[0]).value, "0.00%");
    assert.equal(productParticipatesInInterest(second.products[0], 20, undefined, true), true);
    db.sqlite.close();
  });
}

for (const accountId of ["bybit-global", "bybit-eu"]) {
  test(`${accountId} fixed zero APY plus bad maxStakeAmount does not resurrect cached 8%`, async () => {
    let apy = "8%";
    let max = "300";
    const load = exchangeLoader((url) => {
      const row = { productId: "offer", coin: "USDT", duration: "7d", status: "Available", maxStakeAmount: max, interestCoinApyList: [{ coin: "USDT", apy }] };
      if (url.pathname.endsWith("/fixed-term/product")) return { retCode: 0, result: { list: [row] } };
      if (url.pathname.endsWith("/fixed-term/position")) return { retCode: 0, result: { list: [{ productId: "offer", coin: "USDT", duration: "7d", amount: "20" }] } };
      return { retCode: 0, result: { list: [] } };
    });
    const fetch = accountId === "bybit-global"
      ? () => load("@/lib/integrations/bybit").fetchBybitShortFixedSnapshots(credentials)
      : async () => { const snapshot = await load("@/lib/live-rates").fetchPublicRateSnapshot(); return { ...snapshot, rates: snapshot.rates.filter((rate) => rate.catalog.accountId === accountId), holdings: {} }; };
    const { mergeRateFields } = load("@/lib/rate-cache");
    const initial = await fetch();
    const { db, first, prepareProductCatalogSync } = await existingCatalog(load, initial);
    apy = "0%";
    max = "invalid";
    const next = await fetch();
    const rates = mergeRateFields(next.rates, first.rates);
    assert.equal(next.rates[0].aprStatus, "available");
    assert.equal(next.rates[0].capacityStatus, "unavailable");
    assert.equal(rates[0].apr, 0);
    assert.notEqual(rates[0].aprSource, "cache");
    assert.equal(rates[0].tiers[0].max, 300);
    assert.equal(rates[0].capacitySource, "cache");
    assert.equal(rates[0].capacityFetchedAt, oldTime);
    assert.equal(rates[0].rateCoverage, "complete");
    const second = await prepareProductCatalogSync(db, "test-user", rates, { [rates[0].productId]: 20 }, [accountId]);
    assert.equal(second.products[0].id, first.products[0].id);
    assert.equal(second.products[0].tiers[0].apr, 0);
    apy = "broken%";
    max = "500";
    const aprMissing = mergeRateFields((await fetch()).rates, first.rates)[0];
    assert.equal(aprMissing.apr, 8);
    assert.equal(aprMissing.aprSource, "cache");
    assert.equal(aprMissing.tiers[0].max, 500);
    assert.notEqual(aprMissing.capacitySource, "cache");
    db.sqlite.close();
  });
}

for (const account of ["global", "bahrain"]) {
  test(`Binance ${account} locked preserves APR and quota independently, including the confirmed omitted quota rule`, async () => {
    let apr = "0.08";
    let quota = { totalPersonalQuota: "300" };
    const load = exchangeLoader((url) => url.pathname.endsWith("/locked/list")
      ? { rows: [{ projectId: "offer", detail: { asset: "USDT", duration: 7, apr }, quota }], total: 1 }
      : { rows: [{ projectId: "offer", asset: "USDT", amount: "20", duration: 7 }], total: 1 });
    const fetch = () => load("@/lib/integrations/binance").fetchBinanceLockedSnapshot(credentials, account, ["USDT"]);
    const { mergeRateFields } = load("@/lib/rate-cache");
    const initial = await fetch();
    const { db, first } = await existingCatalog(load, initial);
    apr = "0";
    quota = { totalPersonalQuota: null };
    const next = await fetch();
    const restored = mergeRateFields(next.rates, first.rates)[0];
    assert.equal(next.productApiStatus, "complete");
    assert.equal(restored.apr, 0);
    assert.notEqual(restored.aprSource, "cache");
    assert.equal(restored.tiers[0].max, 300);
    assert.equal(restored.capacitySource, "cache");
    apr = "bad";
    quota = { totalPersonalQuota: "500" };
    const aprMissing = mergeRateFields((await fetch()).rates, first.rates)[0];
    assert.equal(aprMissing.apr, 8);
    assert.equal(aprMissing.tiers[0].max, 500);
    assert.equal(aprMissing.aprSource, "cache");
    assert.notEqual(aprMissing.capacitySource, "cache");
    apr = "0";
    quota = {};
    const unlimited = mergeRateFields((await fetch()).rates, first.rates)[0];
    assert.equal(unlimited.tiers[0].max, null);
    assert.equal(unlimited.tiers[0].maxStatus, "unlimited");
    assert.notEqual(unlimited.capacitySource, "cache");
    db.sqlite.close();
  });
}

test("explicit cancellation clears catalogue facts, but omission preserves them", async () => {
  const load = moduleLoader();
  const now = oldTime;
  const rate = { productId: "bybit-global:USDT:fixed:offer@7d", identityKey: "bybit-global:USDT:fixed:offer@7d",
    productType: "fixed", termDays: 7, subscriptionEndsAt: "2026-10-12T00:00:00.000Z", apr: 8,
    tiers: [{ min: 0, max: 300, apr: 8 }], fetchedAt: now, sourceLabel: "API", rateCoverage: "complete",
    catalog: { accountId: "bybit-global", exchange: "bybit", region: "global", asset: "USDT", holdingDataMode: "api", apiAccess: "public" } };
  const { db, first, prepareProductCatalogSync } = await existingCatalog(load, { rates: [rate], holdings: {} });
  const omitted = { ...first.rates[0] };
  delete omitted.termDays;
  delete omitted.subscriptionEndsAt;
  const unchanged = await prepareProductCatalogSync(db, "test-user", [omitted], {}, []);
  assert.equal(unchanged.products[0].termDays, 7);
  assert.equal(unchanged.products[0].subscriptionEndsAt, rate.subscriptionEndsAt);
  const canceled = await prepareProductCatalogSync(db, "test-user", [{ ...omitted, clearedProductFields: ["termDays", "subscriptionEndsAt"] }], {}, []);
  assert.equal(canceled.products[0].termDays, undefined);
  assert.equal(canceled.products[0].subscriptionEndsAt, undefined);
  db.sqlite.close();
});

for (const accountId of ["bybit-global", "bybit-eu"]) {
  test(`${accountId} flexible preserves independent fields and does not report field failure as incomplete pagination`, async () => {
    let row = { productId: "flexible-offer", coin: "USDT", status: "Available", estimateApr: "8%", maxStakeAmount: "300" };
    const load = exchangeLoader((url) => url.pathname === "/v5/earn/product" && url.hostname === (accountId === "bybit-eu" ? "api.bybit.eu" : "api.bybit.com") && url.searchParams.get("coin") === "USDT"
      ? { retCode: 0, result: { list: [row] } } : { retCode: 0, result: { list: [] } });
    const fetch = async () => { const snapshot = await load("@/lib/live-rates").fetchPublicRateSnapshot(); return { ...snapshot, rates: snapshot.rates.filter((rate) => rate.catalog.accountId === accountId), holdings: {} }; };
    const { mergeRateFields } = load("@/lib/rate-cache");
    const initial = await fetch();
    const { db, first } = await existingCatalog(load, initial);
    row = { ...row, estimateApr: "0%", maxStakeAmount: "bad" };
    const next = await fetch();
    const merged = mergeRateFields(next.rates, first.rates)[0];
    assert.equal(next.partials.length, 0);
    assert.equal(merged.apr, 0);
    assert.notEqual(merged.aprSource, "cache");
    assert.equal(merged.tiers[0].max, 300);
    assert.equal(merged.capacitySource, "cache");
    assert.equal(merged.rateCoverage, "complete");
    row = { ...row, estimateApr: "bad", maxStakeAmount: "500" };
    const aprMissing = mergeRateFields((await fetch()).rates, first.rates)[0];
    assert.equal(aprMissing.apr, 8);
    assert.equal(aprMissing.tiers[0].max, 500);
    assert.equal(aprMissing.aprSource, "cache");
    assert.notEqual(aprMissing.capacitySource, "cache");
    db.sqlite.close();
  });
}

test("Bybit multi-tier field failure can borrow compatible boundaries, but gaps restore the entire old plan", async () => {
  let tiers = [{ min: "0", max: "200", estimateApr: "8%" }, { min: "200", max: "1000", estimateApr: "2%" }];
  const load = exchangeLoader((url) => url.pathname === "/v5/earn/product" && url.hostname === "api.bybit.com" && url.searchParams.get("coin") === "USDT"
    ? { retCode: 0, result: { list: [{ productId: "multi", coin: "USDT", status: "Available", maxStakeAmount: "1000", tierAprDetails: tiers }] } }
    : { retCode: 0, result: { list: [] } });
  const { fetchPublicRateSnapshot } = load("@/lib/live-rates");
  const { mergeRateFields } = load("@/lib/rate-cache");
  const initial = await fetchPublicRateSnapshot();
  initial.rates[0].fetchedAt = oldTime;
  tiers = [{ min: "0", max: "bad", estimateApr: "0%" }, { min: "200", max: "1000", estimateApr: "1%" }];
  const next = await fetchPublicRateSnapshot();
  const [repaired] = mergeRateFields(next.rates, initial.rates);
  assert.equal(next.rates[0].aprStatus, "available");
  assert.equal(next.rates[0].tierStructureStatus, "complete");
  assert.deepEqual(repaired.tiers, [{ min: 0, max: 200, apr: 0 }, { min: 200, max: 1000, apr: 1 }]);
  assert.notEqual(repaired.aprSource, "cache");
  assert.equal(repaired.capacitySource, "cache");
  assert.equal(repaired.rateCoverage, "complete");
  tiers = [{ min: "0", max: "200", estimateApr: "0%" }, { min: "200", max: "bad", estimateApr: "1%" }];
  const unreadableLast = await fetchPublicRateSnapshot();
  assert.equal(unreadableLast.rates[0].tiers[1].max, null);
  assert.equal(unreadableLast.rates[0].tierStructureStatus, "complete");
  const [lastRepaired] = mergeRateFields(unreadableLast.rates, initial.rates);
  assert.deepEqual(lastRepaired.tiers, [{ min: 0, max: 200, apr: 0 }, { min: 200, max: 1000, apr: 1 }]);
  assert.notEqual(lastRepaired.aprSource, "cache");
  tiers = [{ min: "0", max: "100", estimateApr: "0%" }, { min: "200", max: "1000", estimateApr: "1%" }];
  const gap = await fetchPublicRateSnapshot();
  const [restored] = mergeRateFields(gap.rates, initial.rates);
  assert.equal(gap.rates[0].tierStructureStatus, "incomplete");
  assert.deepEqual(restored.tiers, initial.rates[0].tiers);
  assert.equal(restored.aprSource, "cache");
  assert.equal(restored.capacitySource, "cache");
  assert.equal(mergeRateFields(gap.rates, [])[0].rateCoverage, "partial");
});

test("Bitget multi-tier bad fields are preserved independently and a structural gap never becomes a live zero plan", async () => {
  let tiers = [{ minStepVal: "0", maxStepVal: "300", currentApy: "8" }, { minStepVal: "300", maxStepVal: "1000", currentApy: "2" }];
  const load = exchangeLoader((url) => url.pathname.endsWith("/savings/assets")
    ? { code: "00000", data: { resultList: [], endId: "" } }
    : { code: "00000", data: [{ productId: "multi", coin: "USDT", periodType: "flexible", apyType: "ladder", status: "available", apyList: tiers }] });
  const { fetchBitgetSavingsSnapshot } = load("@/lib/integrations/bitget");
  const { mergeRateFields } = load("@/lib/rate-cache");
  const initial = await fetchBitgetSavingsSnapshot(credentials, ["USDT"]);
  initial.rates[0].fetchedAt = oldTime;
  tiers = [{ minStepVal: "0", maxStepVal: "bad", currentApy: "0" }, { minStepVal: "300", maxStepVal: "1000", currentApy: "1" }];
  const next = await fetchBitgetSavingsSnapshot(credentials, ["USDT"]);
  const [repaired] = mergeRateFields(next.rates, initial.rates);
  assert.deepEqual(repaired.tiers, [{ min: 0, max: 300, apr: 0 }, { min: 300, max: 1000, apr: 1 }]);
  assert.notEqual(repaired.aprSource, "cache");
  assert.equal(repaired.capacitySource, "cache");
  tiers = [{ minStepVal: "0", maxStepVal: "300", currentApy: "bad" }, { minStepVal: "300", maxStepVal: "2000", currentApy: "1" }];
  const [aprMissing] = mergeRateFields((await fetchBitgetSavingsSnapshot(credentials, ["USDT"])).rates, initial.rates);
  assert.deepEqual(aprMissing.tiers, [{ min: 0, max: 300, apr: 8 }, { min: 300, max: 2000, apr: 2 }]);
  assert.equal(aprMissing.aprSource, "cache");
  assert.notEqual(aprMissing.capacitySource, "cache");
  tiers = [{ minStepVal: "0", maxStepVal: "200", currentApy: "0" }, { minStepVal: "300", maxStepVal: "1000", currentApy: "1" }];
  const gap = await fetchBitgetSavingsSnapshot(credentials, ["USDT"]);
  assert.equal(gap.rates[0].tierStructureStatus, "incomplete");
  const [restored] = mergeRateFields(gap.rates, initial.rates);
  assert.deepEqual(restored.tiers, initial.rates[0].tiers);
  assert.equal(restored.aprSource, "cache");
  assert.equal(restored.capacitySource, "cache");
});

for (const account of ["global", "bahrain"]) {
  test(`Binance ${account} flexible missing base APR retains valid bonus boundaries for APR-only recovery`, async () => {
    let baseApr = "0.03";
    let bonusApr = "0.05";
    const load = exchangeLoader((url) => url.pathname.endsWith("/flexible/list")
      ? { rows: [{ productId: "flexible", asset: "USDT", latestAnnualPercentageRate: baseApr, tierAnnualPercentageRate: { "0-300": bonusApr } }], total: 1 }
      : { rows: [], total: 0 });
    const { fetchBinanceFlexibleSnapshot } = load("@/lib/integrations/binance");
    const { mergeRateFields } = load("@/lib/rate-cache");
    const initial = await fetchBinanceFlexibleSnapshot(credentials, account, ["USDT"]);
    initial.rates[0].fetchedAt = oldTime;
    baseApr = "bad";
    const next = await fetchBinanceFlexibleSnapshot(credentials, account, ["USDT"]);
    assert.equal(next.productApiStatus, "complete");
    assert.equal(next.rates[0].aprStatus, "unavailable");
    assert.equal(next.rates[0].capacityStatus, "available");
    const [restored] = mergeRateFields(next.rates, initial.rates);
    assert.deepEqual(restored.tiers, initial.rates[0].tiers);
    assert.equal(restored.aprSource, "cache");
    assert.notEqual(restored.capacitySource, "cache");
    baseApr = "0";
    bonusApr = "0";
    const [zero] = mergeRateFields((await fetchBinanceFlexibleSnapshot(credentials, account, ["USDT"])).rates, initial.rates);
    assert.equal(zero.apr, 0);
    assert.equal(zero.aprStatus, "available");
    assert.notEqual(zero.aprSource, "cache");
  });
}
