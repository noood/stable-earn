import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

const load = moduleLoader();
const { buildSyncChangeEvents, loadProductChangeEvents, markProductChangeEventsRead, prepareProductChangeEventStatements } = load("@/lib/product-change-events");
const { mergeNewProductHistoryEvents, mergeProductHistoryEvents, productHistoryRevision } = load("@/lib/product-history-state");
const { parseProductOverride } = load("@/lib/product-override-input");
const oldTime = "2026-10-09T00:00:00.000Z";
const newTime = "2026-10-10T00:00:00.000Z";
const rate = {
  productId: "product-a", apr: 8, tiers: [{ min: 0, max: 300, apr: 8 }],
  termDays: 7, subscriptionEndsAt: "2026-10-12T00:00:00.000Z", availability: "available",
  fetchedAt: oldTime,
};

test("holding-only rows and unreadable fields cannot invent deadline, term, availability or APR changes", () => {
  for (const missing of [
    { productId: "product-a", apr: 0, aprStatus: "unavailable", capacityStatus: "unavailable", fetchedAt: newTime },
    { ...rate, termDays: undefined, subscriptionEndsAt: undefined, availability: undefined, fetchedAt: newTime },
    { ...rate, termDays: Number.NaN, subscriptionEndsAt: "invalid", availability: "unknown", fetchedAt: newTime },
  ]) {
    assert.deepEqual(buildSyncChangeEvents({ rates: [rate] }, { rates: [missing] }, "手动刷新", newTime), []);
  }
});

test("history records confirmed changes and explicit cancellation instead of treating omission as cancellation", () => {
  const current = { ...rate, termDays: 5, subscriptionEndsAt: "2026-10-11T00:00:00.000Z", availability: "unavailable" };
  const changed = buildSyncChangeEvents({ rates: [rate] }, { rates: [current] }, "手动刷新", newTime);
  assert.deepEqual(changed.map(({ title }) => title), ["锁定期限变化", "认购截止变化", "申购状态变化"]);
  const cleared = { ...rate, termDays: undefined, subscriptionEndsAt: undefined, clearedProductFields: ["termDays", "subscriptionEndsAt"] };
  assert.deepEqual(buildSyncChangeEvents({ rates: [rate] }, { rates: [cleared] }, "手动刷新", newTime).map(({ after }) => after), ["无锁定期限", "无截止日期"]);
});

test("a fresh explicit APR zero is recorded independently of an unreadable capacity", () => {
  const current = { ...rate, apr: 0, tiers: [{ min: 0, max: null, apr: 0 }], aprStatus: "available", capacityStatus: "unavailable", rateCoverage: "partial" };
  const changed = buildSyncChangeEvents({ rates: [rate] }, { rates: [current] }, "手动刷新", newTime);
  assert.deepEqual(changed.map(({ title, after }) => ({ title, after })), [{ title: "首档 APR 下调", after: "0.00%" }]);
});

const event = (id, observedAt = oldTime, extra = {}) => ({
  id, productId: "product-a", observedAt, source: "手动刷新", type: "rate", title: "首档 APR 下调", attention: true, ...extra,
});

test("refreshed history merges new events with loaded older pages and never revokes confirmed read state", () => {
  const oldPage = [event("old-2"), event("old-1", "2026-10-08T00:00:00.000Z")];
  const newProps = [event("new", newTime), event("old-2", oldTime, { readAt: newTime })];
  const merged = mergeProductHistoryEvents(newProps, oldPage, [event("new", newTime)]);
  assert.deepEqual(merged.map(({ id }) => id), ["new", "old-2", "old-1"]);
  assert.equal(merged.find(({ id }) => id === "old-2").readAt, newTime);
  assert.equal(productHistoryRevision(newProps), productHistoryRevision(newProps.map((item) => ({ ...item, readAt: newTime }))));
  assert.notEqual(productHistoryRevision(oldPage), productHistoryRevision(newProps));
  const onlyLoadedAndNew = mergeNewProductHistoryEvents([event("loaded-head")], [event("new", newTime), event("unpaged-old", "2026-10-01T00:00:00.000Z")]);
  assert.deepEqual(onlyLoadedAndNew.map(({ id }) => id), ["new", "loaded-head"], "older snapshot props cannot bypass history pagination");
  const equalTimeUnpaged = mergeNewProductHistoryEvents([event("loaded-head")], [event("unpaged-same-time"), event("new-same-time")], ["unpaged-same-time"]);
  assert.deepEqual(equalTimeUnpaged.map(({ id }) => id), ["new-same-time", "loaded-head"], "initial snapshot IDs at the same timestamp remain paged, while truly new IDs can be displayed");
});

test("read acknowledgement only affects presented IDs, even if a new attention event arrives before POST", async () => {
  const db = sqliteDb();
  await db.batch(prepareProductChangeEventStatements(db, "user-1", [event("shown"), event("arrived-after-read", newTime)]));
  await db.batch(prepareProductChangeEventStatements(db, "user-1", [event("other-product", oldTime, { productId: "product-b" })]));
  await db.batch(prepareProductChangeEventStatements(db, "user-2", [event("other-owner")]));
  await markProductChangeEventsRead(db, "user-1", "product-a", ["shown", "other-product", "other-owner"], newTime);
  const mine = await loadProductChangeEvents(db, "user-1");
  assert.equal(mine.find(({ id }) => id === "shown").readAt, newTime);
  assert.equal(mine.find(({ id }) => id === "arrived-after-read").readAt, undefined);
  assert.equal(mine.find(({ id }) => id === "other-product").readAt, undefined);
  assert.equal((await loadProductChangeEvents(db, "user-2"))[0].readAt, undefined);
});

test("history POST rejects an absent, empty or malformed acknowledgement boundary", async () => {
  const route = moduleLoader({
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/db": { getDatabase: () => { throw new Error("invalid input must not access DB"); }, getUserIdentity: async () => ({ userId: "user-1" }) },
    "@/lib/request-security": { privateResponseHeaders: {}, isSameOriginMutation: () => true },
  })("@/app/private/api/product-history/route");
  for (const body of [null, [], { productId: "product-a" }, { productId: "product-a", eventIds: [] }, { productId: "product-a", eventIds: [true] }, { productId: "product-a", eventIds: Array(51).fill("id") }]) {
    const response = await route.POST(new Request("https://example.test/private/api/product-history", { method: "POST", body: JSON.stringify(body) }));
    assert.equal(response.status, 400);
  }
});

test("credentials PUT rejects non-object JSON without accessing credentials or the database", async () => {
  const route = moduleLoader({
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/db": { getUserIdentity: async () => ({ userId: "user-1" }), getDatabase: () => { throw new Error("invalid input must not access DB"); } },
    "@/lib/credentials": { credentialAccount: () => { throw new Error("invalid input must not access credential accounts"); } },
    "@/lib/request-security": { privateResponseHeaders: {}, isSameOriginMutation: () => true },
  })("@/app/private/api/credentials/route");
  for (const body of [null, [], "value", 1, true]) {
    const response = await route.PUT(new Request("https://example.test/private/api/credentials", { method: "PUT", body: JSON.stringify(body) }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "配置格式不正确。");
  }
});

const manualProduct = { id: "manual", productDataMode: "manual", manualFields: { termDays: true }, tiers: [{ min: 0, max: null, apr: 0 }], source: { kind: "manual" } };

test("manual numeric fields reject coercible booleans, arrays, objects and malformed numeric strings", () => {
  for (const field of ["apr", "firstTierLimit", "termDays"]) {
    for (const invalid of [true, false, [], [1], {}, { valueOf: () => 1 }, " ", "12abc", "0x10", Number.NaN, Infinity]) {
      assert.equal(parseProductOverride(manualProduct, { [field]: invalid }), null, `${field}: ${String(invalid)}`);
    }
  }
  for (const raw of [null, [], true, "value"]) assert.equal(parseProductOverride(manualProduct, raw), null);
});

test("manual numeric parsing preserves explicit zero APR, valid numeric strings and optional empty values", () => {
  assert.deepEqual(parseProductOverride(manualProduct, { apr: 0, firstTierLimit: "300", termDays: "7", purchaseDate: "2026-10-10" }), {
    productId: "manual", apr: 0, firstTierLimit: 300, termDays: 7, purchaseDate: "2026-10-10",
  });
  assert.deepEqual(parseProductOverride(manualProduct, { apr: "", firstTierLimit: null, termDays: undefined }), {
    productId: "manual", apr: null, firstTierLimit: null, termDays: null, purchaseDate: null,
  });
});
