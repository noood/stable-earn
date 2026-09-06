import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

const load = moduleLoader();
const { productInformationIssues, productParticipatesInInterest, holdingSyncNote } = load("@/lib/product-status");
const { productHasComparableApr, productHasKnownCapacity, productShouldBeActive } = load("@/lib/opportunity-policy");
const { applyProductOverride, productTermStatus } = load("@/lib/product-overrides");
const { syncFailureSummary, nextScheduledRefreshAt } = load("@/lib/sync-notice");
const { localPrivateProductsPreview, localSyncScenarioPreview } = load("@/lib/local-preview");
const base = localPrivateProductsPreview().products.find((p) => p.id === "bn-g-usdt");

test("product completeness and holdings remain independent", () => {
  for (const rateCoverage of ["unavailable", "base_only", "max_only"]) {
    const product = { ...base, rateCoverage };
    assert.ok(productInformationIssues(product).length);
    assert.equal(productParticipatesInInterest(product, 100), false);
    assert.equal(productHasKnownCapacity(product), false);
    assert.equal(productHasComparableApr(product), rateCoverage !== "unavailable");
  }
  assert.equal(productParticipatesInInterest(base, 100), true);
  assert.equal(productParticipatesInInterest(base, 0), false);
});

test("manual missing fields, maturity and eligibility do not invent a holding state", () => {
  const manual = { ...base, productDataMode: "manual", manualKind: "limited", termDays: 180 };
  const override = { apr: 10, firstTierLimit: 500, purchaseDate: null };
  const product = applyProductOverride(manual, override);
  assert.deepEqual(productInformationIssues(product, override), ["买入日待填写"]);
  assert.equal(productHasKnownCapacity(product), true);
  const held = { ...base, productType: "fixed", termDays: 180, eligibilityStatus: "ineligible", availability: "unavailable" };
  assert.equal(productParticipatesInInterest(held, 100, { purchaseDate: "2026-01-01" }), true);
  assert.ok(productTermStatus(held, "2026-01-01", new Date("2026-09-06T00:00:00Z")).remainingDays < 0);
  assert.equal(productShouldBeActive(held, { known: true, amount: 100 }), true);
  assert.equal(productShouldBeActive(held, { known: true, amount: 0 }), false);
});

test("opportunity boundary is inclusive at 6%, long terms need a holding", () => {
  const fixed = { ...base, productType: "fixed", termDays: 7, tiers: [{ min: 0, max: 100, apr: 6 }] };
  assert.equal(productShouldBeActive(fixed, { known: true, amount: 0 }), true);
  assert.equal(productShouldBeActive({ ...fixed, termDays: 30 }, { known: true, amount: 0 }), false);
  assert.equal(productShouldBeActive({ ...fixed, termDays: 30 }, { known: true, amount: 10 }), true);
  assert.equal(holdingSyncNote("error"), "API 同步失败");
  assert.equal(holdingSyncNote("synced"), "接口未返回该产品持仓");
});

test("banner distinguishes whole failure, interface scope and page network failure", () => {
  assert.match(syncFailureSummary(["Bitget（持仓接口未完整返回）"]), /Bitget 持仓 API/);
  assert.match(syncFailureSummary(["Bybit.com 定期产品", "Bybit.com 定期持仓"]), /定期产品、Bybit.com 定期持仓/);
  assert.match(syncFailureSummary(["Bitget（USDGO 产品未返回）"]), /Bitget USDGO/);
  assert.match(syncFailureSummary(["产品和持仓数据更新失败"]), /^本次产品和持仓数据更新失败/);
  assert.match(syncFailureSummary(["页面数据读取失败"]), /^页面数据读取失败/);
});

test("next refresh uses Shanghai 06:00 and 18:00 across day boundaries", () => {
  assert.equal(nextScheduledRefreshAt(Date.parse("2026-09-05T21:59:00Z")), "2026-09-05T22:00:00.000Z");
  assert.equal(nextScheduledRefreshAt(Date.parse("2026-09-05T22:00:00Z")), "2026-09-06T10:00:00.000Z");
  assert.equal(nextScheduledRefreshAt(Date.parse("2026-09-06T10:00:00Z")), "2026-09-06T22:00:00.000Z");
});

test("repeated local preview requests keep the failed holding timestamp fixed", () => {
  const first = localSyncScenarioPreview("partial", new Date("2026-09-06T01:00:00Z"));
  const second = localSyncScenarioPreview("partial", new Date("2026-09-06T01:05:00Z"));
  assert.notEqual(first.cache.updatedAt, second.cache.updatedAt);
  assert.deepEqual(first.holdingFallbacks, second.holdingFallbacks);
  assert.deepEqual(localSyncScenarioPreview("success").holdingFallbacks, {});
});
