import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

const load = moduleLoader();
const { rateHeadlineFor } = load("@/lib/product-rate-presentation");
const { productInformationIssues, productParticipatesInInterest } = load("@/lib/product-status");
const product = (overrides = {}) => ({
  id: "api-product", accountId: "bybit-global", exchange: "bybit", region: "global", asset: "USDT",
  productDataMode: "api", apiAccess: "public", holdingDataMode: "api", productType: "flexible",
  rateCoverage: "partial", source: { kind: "live" }, tiers: [{ id: "tier", min: 0, max: null, apr: 7 }], ...overrides,
});

test("an unreadable quota is never presented as an open-ended tier", () => {
  for (const rateCoverage of ["complete", "base_only", "partial", "unavailable"]) {
    const headline = rateHeadlineFor(product({ rateCoverage }));
    assert.equal(headline.label, "首档 · 上限未获取");
    assert.equal(headline.label.includes("以上"), false);
  }
  assert.equal(rateHeadlineFor(product({ rateCoverage: "complete", tiers: [{ id: "tier", min: 0, max: null, apr: 7, maxStatus: "unlimited" }] })).label, "首档 · 0.00 以上");
});

test("missing APR does not hide a confirmed quota in either source mode", () => {
  for (const productDataMode of ["api", "manual"]) {
    const incomplete = product({ productDataMode, rateCoverage: "unavailable", aprStatus: "unavailable", capacityStatus: "available",
      tiers: [{ id: "tier", min: 0, max: 300, apr: 0 }] });
    assert.equal(rateHeadlineFor(incomplete).label, "首档 · 0.00–300.00");
    assert.equal(rateHeadlineFor(incomplete).value, productDataMode === "api" ? "APR 未获取" : "APR 待填写");
    assert.equal(productParticipatesInInterest(incomplete, 20), false);
  }
});

test("both missing fields are named without converting either into zero or unlimited", () => {
  const incomplete = product({ rateCoverage: "unavailable", aprStatus: "unavailable", capacityStatus: "unavailable" });
  assert.deepEqual(productInformationIssues(incomplete), ["APR 未获取", "首档额度未获取"]);
  assert.equal(rateHeadlineFor(incomplete).value, "APR 未获取");
  assert.equal(productParticipatesInInterest(incomplete, 20), false);
});

test("manual template bounds do not claim an unfilled manual quota is unlimited or complete", () => {
  const manual = product({ productDataMode: "manual", rateCoverage: "base_only", source: { kind: "manual" },
    tiers: [{ id: "tier", min: 0, max: 300, apr: 7 }] });
  assert.equal(rateHeadlineFor(manual).label, "首档额度待填写");
  assert.equal(rateHeadlineFor({ ...manual, rateCoverage: "unavailable", tiers: [{ id: "tier", min: 0, max: null, apr: 0, maxStatus: "unlimited" }] }).label, "首档额度待填写");
});
