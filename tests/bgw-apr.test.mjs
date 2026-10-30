import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

const load = moduleLoader();
const { effectiveApr } = load("@/lib/domain");
const { bitgetWalletRate } = load("@/lib/bitget-wallet-product");
const { productInformationIssues, productParticipatesInInterest } = load("@/lib/product-status");
const { rateHeadlineFor } = load("@/lib/product-rate-presentation");
const { applyProductOverride, productNeedsManualLimit } = load("@/lib/product-overrides");
const { parseProductOverride } = load("@/lib/product-override-input");

function product(apr = 6.73) {
  const rate = bitgetWalletRate();
  const base = { ...rate, id: "synthetic-bgw", accountId: rate.catalog.accountId, exchange: "bitget-wallet", region: "morph",
    asset: "USDC", holdingDataMode: "api", source: { kind: "manual", label: rate.sourceLabel } };
  const override = parseProductOverride(base, { apr, firstTierUnlimited: true });
  return applyProductOverride(base, override);
}

test("BGW uses the entered APR directly for comparison and simple daily estimates", () => {
  const p = product(6.72);
  assert.equal(effectiveApr(p, 10000), 6.72);
  assert.ok(Math.abs(10000 * effectiveApr(p, 10000) / 100 / 365 - 1.841095890410959) < 1e-12);
  assert.equal(effectiveApr(p, 0), 0);
});

test("manual APR reuses an explicitly unlimited tier under the selected product assumption", () => {
  const p = product();
  assert.deepEqual(productInformationIssues(p), []);
  assert.equal(productParticipatesInInterest(p, 123), true);
  assert.equal(p.tiers[0].max, null);
  assert.equal(p.tiers[0].maxStatus, "unlimited");
  assert.equal(p.capacityStatus, "available");
  assert.equal(rateHeadlineFor(p).label, "不限额");
  assert.equal(rateHeadlineFor(p).value, "6.73%");
});

test("missing manual APR keeps holdings but blocks estimates instead of becoming zero yield", () => {
  const p = product(null);
  assert.deepEqual(productInformationIssues(p), ["APR 待填写"]);
  assert.equal(productParticipatesInInterest(p, 123), false);
  assert.equal(rateHeadlineFor(p).value, "APR 待填写");
});

test("APR-tier calculations retain their existing weighted behavior", () => {
  assert.equal(effectiveApr({ tiers: [{ min: 0, max: 100, apr: 10 }, { min: 100, max: null, apr: 2 }] }, 200), 6);
});


test("manual APR accepts zero, clears explicitly and reuses the selected unlimited quota", () => {
  const zero = product(0);
  assert.equal(zero.rateCoverage, "complete");
  assert.equal(zero.aprStatus, "available");
  assert.equal(productNeedsManualLimit(zero), true);
  assert.deepEqual(productInformationIssues(zero), []);
  assert.equal(productParticipatesInInterest(zero, 123), true);
  assert.equal(effectiveApr(zero, 123), 0);
  assert.equal(rateHeadlineFor(zero).value, "0.00%");
  const cleared = applyProductOverride(zero, { apr: null });
  assert.equal(cleared.rateCoverage, "unavailable");
  assert.equal(productParticipatesInInterest(cleared, 123), false);
  assert.equal(rateHeadlineFor(cleared).value, "APR 待填写");
});

test("manual APR parser accepts manual quota and ignores hidden lifecycle edits", () => {
  const base = product(null);
  for (const apr of [-1, NaN, Infinity, true, [], "abc", 10001]) {
    assert.equal(parseProductOverride(base, { apr }), null);
  }
  const saved = parseProductOverride(base, { apr: "6.72", firstTierLimit: 500, termDays: 30, purchaseDate: "2026-10-01" });
  assert.equal(saved.apr, 6.72);
  assert.equal(saved.firstTierLimit, 500);
  assert.equal(saved.termDays, null);
  assert.equal(saved.purchaseDate, null);
});


test("an obsolete APY marker cannot reinstate compound conversion for the manual BGW rate", () => {
  const p = { ...product(6.72), rateBasis: "apy" };
  assert.equal(effectiveApr(p, 10000), 6.72);
  assert.equal(rateHeadlineFor(p).label, "不限额");
});
