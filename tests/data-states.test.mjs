import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

const load = moduleLoader();
const { productInformationIssues, productParticipatesInInterest, holdingSyncNote } = load("@/lib/product-status");
const { productHasComparableApr, productHasKnownCapacity, productShouldBeActive } = load("@/lib/opportunity-policy");
const { applyProductOverride, productTermStatus } = load("@/lib/product-overrides");
const { syncFailureSummary, sanitizeSyncFailure, nextScheduledRefreshAt, scheduledRefreshPending } = load("@/lib/sync-notice");
const { scheduledRefreshMetadata } = load("@/lib/sync-cache");
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

test("maturity history uses one resolved date instead of a before/after pair", () => {
  const preview = localPrivateProductsPreview(new Date("2026-10-02T12:00:00Z"));
  const event = preview.changeEvents.find((item) => item.type === "maturity");
  assert.ok(event);
  assert.match(event.title, /^定期于 10\/01 到期$/);
  assert.equal(event.before, undefined);
  assert.equal(event.after, undefined);
});

test("local preview includes a long history for scroll-boundary review", () => {
  const preview = localPrivateProductsPreview(new Date("2026-10-02T12:00:00Z"));
  const events = preview.changeEvents.filter((item) => item.productId === "bn-g-usdt");
  assert.ok(events.length >= 26);
  assert.ok(events.some((item) => item.type === "rate"));
  assert.ok(events.some((item) => item.type === "capacity"));
  assert.ok(events.some((item) => item.type === "holding"));
  assert.ok(events.some((item) => item.type === "availability"));
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

test("qualification-restricted products need eligibility or a positive holding", () => {
  const restricted = {
    ...base,
    eligibilityRequired: true,
    eligibilityStatus: "unknown",
    tiers: [{ min: 0, max: 300, apr: 10 }],
  };
  assert.equal(productShouldBeActive(restricted, { known: true, amount: 0 }), false);
  assert.equal(productShouldBeActive({ ...restricted, eligibilityStatus: "eligible" }, { known: true, amount: 0 }), true);
  assert.equal(productShouldBeActive(restricted, { known: true, amount: 20 }), true);
  assert.equal(productShouldBeActive(restricted, { known: false, amount: 0 }, true), true);
  assert.equal(productShouldBeActive(restricted, { known: false, amount: 0 }, false), false);
});

test("banner distinguishes whole failure, interface scope and page network failure", () => {
  assert.match(syncFailureSummary(["Bitget（持仓接口未完整返回）"]), /Bitget 持仓 API/);
  assert.equal(sanitizeSyncFailure("Bitget（USDT:1382948397058678784、USDT:1488775596992425984 持仓未返回）"), "Bitget（部分数据未返回）");
  assert.equal(sanitizeSyncFailure("Bitget USDT:1382948397058678784 持仓未返回"), "Bitget（部分数据未返回）");
  assert.equal(syncFailureSummary(["Bitget（USDT:1382948397058678784、USDT:1488775596992425984 持仓未返回）"]), "Bitget 部分数据未返回；下次更新将重试。");
  assert.equal(
    syncFailureSummary(["Bitget（持仓接口未完整返回）", "OKX（连接失败，原因待检查）"]),
    "Bitget 持仓 API 暂不可用、OKX API 暂不可用；下次更新将重试。",
  );
  assert.equal(
    syncFailureSummary(["Bybit.com 定期产品", "Bybit.com 定期持仓"]),
    "Bybit.com 定期产品 API 暂不可用、Bybit.com 定期持仓 API 暂不可用；下次更新将重试。",
  );
  assert.equal(syncFailureSummary(["Bitget（USDGO 产品未返回）"]), "Bitget USDGO 产品未返回；下次更新将重试。");
  assert.match(syncFailureSummary(["产品和持仓数据更新失败"]), /^本次产品和持仓数据更新失败/);
  assert.equal(syncFailureSummary(["页面数据读取失败"]), "服务器读取失败，数据无法显示，请刷新页面。");
});

test("next refresh uses Shanghai 07:00 across day and month boundaries", () => {
  assert.equal(nextScheduledRefreshAt(Date.parse("2026-09-05T22:59:00Z")), "2026-09-05T23:00:00.000Z");
  assert.equal(nextScheduledRefreshAt(Date.parse("2026-09-05T23:00:00Z")), "2026-09-06T23:00:00.000Z");
  assert.equal(nextScheduledRefreshAt(Date.parse("2026-09-06T10:00:00Z")), "2026-09-06T23:00:00.000Z");
  assert.equal(nextScheduledRefreshAt(Date.parse("2026-09-30T23:00:00Z")), "2026-10-01T23:00:00.000Z");
});

test("scheduled metadata keeps an unresolved slot instead of rolling to tomorrow", () => {
  const beforeSlot = Date.parse("2026-09-05T22:59:00Z");
  const duringSlot = Date.parse("2026-09-05T23:01:00Z");
  const afterSuccess = Date.parse("2026-09-05T23:02:00Z");
  const oldData = { updatedAt: "2026-09-05T06:23:00Z", lastAttemptAt: "2026-09-05T06:23:00Z", lastError: null };
  assert.deepEqual(scheduledRefreshMetadata(oldData, beforeSlot), {
    scheduledAt: "2026-09-05T23:00:00.000Z", scheduledState: "scheduled",
  });
  assert.deepEqual(scheduledRefreshMetadata(oldData, duringSlot), {
    scheduledAt: "2026-09-05T23:00:00.000Z", scheduledState: "syncing",
  });
  assert.deepEqual(scheduledRefreshMetadata({ ...oldData, updatedAt: new Date(afterSuccess).toISOString() }, afterSuccess), {
    scheduledAt: "2026-09-06T23:00:00.000Z", scheduledState: "scheduled",
  });
  assert.deepEqual(scheduledRefreshMetadata({ ...oldData, lastAttemptAt: new Date(duringSlot).toISOString(), lastError: "failed" }, afterSuccess), {
    scheduledAt: "2026-09-06T23:00:00.000Z", scheduledState: "scheduled",
  });
});

test("before Shanghai 07:00, metadata still checks yesterday's scheduled slot", () => {
  const now = Date.parse("2026-10-02T22:00:00Z"); // 2026-10-03 06:00 in Shanghai
  const record = { updatedAt: "2026-10-01T06:00:00Z", lastAttemptAt: "2026-10-01T06:00:00Z", lastError: null };
  assert.deepEqual(scheduledRefreshMetadata(record, now), {
    scheduledAt: "2026-10-01T23:00:00.000Z",
    scheduledState: "overdue",
  });
});

test("repeated local preview requests keep the failed holding timestamp fixed", () => {
  const first = localSyncScenarioPreview("partial", new Date("2026-09-06T01:00:00Z"));
  const second = localSyncScenarioPreview("partial", new Date("2026-09-06T01:05:00Z"));
  assert.notEqual(first.cache.updatedAt, second.cache.updatedAt);
  assert.deepEqual(first.holdingFallbacks, second.holdingFallbacks);
  assert.deepEqual(localSyncScenarioPreview("success").holdingFallbacks, {});
});

const previousSnapshot = {
  state: "fresh", updatedAt: "2026-09-05T06:23:00Z",
  lastAttemptAt: "2026-09-05T06:23:00Z", lastError: null,
};
const at = (time) => Date.parse(`2026-09-06T${time}+08:00`);

test("scheduled banner covers the exact 07:00 boundary before the next poll", () => {
  assert.equal(scheduledRefreshPending(at("06:59:59"), previousSnapshot), false);
  assert.equal(scheduledRefreshPending(at("07:00:00"), previousSnapshot), true);
  assert.equal(scheduledRefreshPending(at("07:00:59"), previousSnapshot), true);
  assert.equal(scheduledRefreshPending(at("07:03:30"), previousSnapshot), true);
  assert.equal(scheduledRefreshPending(at("07:15:00"), previousSnapshot), false);
});

test("scheduled banner handles 07:00 and a first load with no cache", () => {
  assert.equal(scheduledRefreshPending(at("06:59:59"), null), false);
  assert.equal(scheduledRefreshPending(at("07:00:00"), null), true);
  assert.equal(scheduledRefreshPending(at("07:14:59"), null), true);
  assert.equal(scheduledRefreshPending(at("07:15:00"), null), false);
});

test("old errors do not hide the new slot; committed full or partial results end it", () => {
  assert.equal(scheduledRefreshPending(at("07:00:00"), { ...previousSnapshot, lastError: "old failure" }), true);
  for (const state of ["updated", "fresh", "cooldown"]) {
    assert.equal(scheduledRefreshPending(at("07:01:00"), {
      ...previousSnapshot, state, updatedAt: "2026-09-05T23:00:30Z",
    }), false);
  }
  assert.equal(scheduledRefreshPending(at("07:04:00"), {
    ...previousSnapshot, state: "error", lastAttemptAt: "2026-09-05T23:03:30Z", lastError: "final failure",
  }), false);
});

test("observed attempts stay updating through retries but cannot remain updating forever", () => {
  const running = { ...previousSnapshot, state: "syncing", lastAttemptAt: "2026-09-05T23:03:00Z" };
  assert.equal(scheduledRefreshPending(at("07:03:30"), running), true);
  assert.equal(scheduledRefreshPending(at("07:16:00"), running), true);
  assert.equal(scheduledRefreshPending(at("07:18:00"), running), false);
  assert.equal(scheduledRefreshPending(at("07:00:00"), {
    ...running, lastAttemptAt: "2026-09-05T22:00:00Z",
  }), true);
});
