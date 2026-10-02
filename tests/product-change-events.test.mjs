import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

const load = moduleLoader();
const {
  buildManualChangeEvents,
  buildSyncChangeEvents,
  loadProductChangeEvents,
  prepareProductChangeEventStatements,
} = load("@/lib/product-change-events");

const observedAt = "2026-10-02T12:00:00.000Z";

test("sync changes are classified and persisted in one shared event table", async () => {
  const previous = {
    rates: [{
      productId: "api-usdt",
      apr: 6.8,
      tiers: [{ min: 0, max: 500, apr: 6.8 }],
      fetchedAt: "2026-10-01T12:00:00.000Z",
      sourceLabel: "API",
      termDays: 7,
      availability: "available",
      eligibilityStatus: "eligible",
    }],
    holdingUpdates: { "api-usdt": 100 },
  };
  const current = {
    rates: [{
      productId: "api-usdt",
      apr: 5.8,
      tiers: [{ min: 0, max: 300, apr: 5.8 }],
      fetchedAt: observedAt,
      sourceLabel: "API",
      termDays: 14,
      availability: "unavailable",
      eligibilityStatus: "ineligible",
      capacitySource: "live",
      catalog: { asset: "USDT" },
    }],
    holdingUpdates: { "api-usdt": 120 },
  };
  const events = buildSyncChangeEvents(previous, current, "手动刷新", observedAt);
  assert.deepEqual(events.map((event) => event.type), ["rate", "capacity", "maturity", "availability", "holding"]);
  assert.equal(events[0].attention, true);
  assert.equal(events[1].before, "500.00 USDT");
  assert.equal(events[1].after, "300.00 USDT");
  assert.equal(events.every((event) => event.source === "手动刷新"), true);

  const db = sqliteDb();
  await db.batch(prepareProductChangeEventStatements(db, "user-1", events));
  const stored = await loadProductChangeEvents(db, "user-1");
  assert.equal(stored.length, events.length);
  assert.equal(stored.some((event) => event.type === "rate" && event.attention), true);
  assert.equal(stored.some((event) => event.type === "holding" && event.after === "120.00"), true);
});

test("fallback values do not create false product changes", () => {
  const events = buildSyncChangeEvents(
    { rates: [{ productId: "api-usdt", apr: 6, tiers: [{ min: 0, max: 500, apr: 6 }] }] },
    {
      rates: [{ productId: "api-usdt", apr: 6, tiers: [{ min: 0, max: 300, apr: 6 }], capacitySource: "cache" }],
      rateFallbacks: { "api-usdt": "2026-10-01T12:00:00.000Z" },
    },
    "定时刷新",
    observedAt,
  );
  assert.deepEqual(events, []);
});

test("an omitted quota is unknown, while an explicit unlimited quota is comparable", () => {
  const unknown = buildSyncChangeEvents(
    { rates: [{ productId: "api-usdt", apr: 6 }] },
    {
      rates: [{ productId: "api-usdt", apr: 6, tiers: [{ min: 0, max: 300, apr: 6 }], capacitySource: "live" }],
    },
    "定时刷新",
    observedAt,
  );
  assert.deepEqual(unknown, []);

  const unlimitedToLimited = buildSyncChangeEvents(
    { rates: [{ productId: "api-usdt", apr: 6, tiers: [{ min: 0, max: null, apr: 6 }] }] },
    {
      rates: [{ productId: "api-usdt", apr: 6, tiers: [{ min: 0, max: 300, apr: 6 }], capacitySource: "live", catalog: { asset: "USDT" } }],
    },
    "定时刷新",
    observedAt,
  );
  assert.deepEqual(unlimitedToLimited.map((event) => [event.before, event.after, event.attention]), [["不限额", "300.00 USDT", true]]);

  const limitedToUnlimited = buildSyncChangeEvents(
    { rates: [{ productId: "api-usdt", apr: 6, tiers: [{ min: 0, max: 300, apr: 6 }] }] },
    {
      rates: [{ productId: "api-usdt", apr: 6, tiers: [{ min: 0, max: null, apr: 6 }], capacitySource: "live", catalog: { asset: "USDT" } }],
    },
    "定时刷新",
    observedAt,
  );
  assert.deepEqual(limitedToUnlimited.map((event) => [event.before, event.after, event.attention]), [["300.00 USDT", "不限额", false]]);
});

test("a refresh records a maturity when an existing position crosses its redeem date", () => {
  const position = { productId: "fixed-usdt", positionId: "position-1", amount: 100, redeemAt: "2026-10-02T10:00:00.000Z", source: "api" };
  const events = buildSyncChangeEvents(
    { fetchedAt: "2026-10-02T09:00:00.000Z", holdingPositions: [position] },
    { fetchedAt: observedAt, holdingPositions: [position] },
    "定时刷新",
    observedAt,
  );
  assert.deepEqual(events.map((event) => event.title), ["定期于 10/02 到期"]);
  assert.equal(events[0].attention, true);
});

test("manual edits are recorded with the manual source", () => {
  const product = {
    id: "manual-usdt",
    accountId: "binance-global",
    asset: "USDT",
    productType: "flexible",
    manualKind: "flexible",
  };
  const events = buildManualChangeEvents(
    { "manual-usdt": 10 },
    { "manual-usdt": 25 },
    { "manual-usdt": { apr: 7, firstTierLimit: 500, termDays: null, purchaseDate: null, updatedAt: null } },
    { "manual-usdt": { apr: 6, firstTierLimit: 300, termDays: null, purchaseDate: null, updatedAt: observedAt } },
    [product],
    [product],
    [product],
    { holdingProductIds: ["manual-usdt"], overrideProductIds: ["manual-usdt"], manualProductIds: [], deletedManualProductIds: [] },
    observedAt,
  );
  assert.deepEqual(events.map((event) => event.type), ["holding", "rate", "capacity"]);
  assert.equal(events.every((event) => event.source === "手动编辑"), true);
  assert.equal(events[1].attention, true);
});
