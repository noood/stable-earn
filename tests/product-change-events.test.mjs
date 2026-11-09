import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

const load = moduleLoader();
const {
  buildManualChangeEvents,
  buildManualMaturityEvents,
  buildSyncChangeEvents,
  loadProductChangeEventPage,
  loadProductChangeEvents,
  loadProductHistorySummaries,
  markProductChangeEventsRead,
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
  assert.equal(events.filter((event) => event.attention).length, 1);
  assert.equal(events.some((event) => event.type === "holding" && event.attention), false);

  const db = sqliteDb();
  await db.batch(prepareProductChangeEventStatements(db, "user-1", events));
  const stored = await loadProductChangeEvents(db, "user-1");
  assert.equal(stored.length, events.length);
  assert.equal(stored.some((event) => event.type === "rate" && event.attention), true);
  assert.equal(stored.some((event) => event.type === "holding" && event.after === "120.00"), true);
});

test("a cached APR does not create a rate event, while a live quota change is still recorded", () => {
  const previous = {
    rates: [{
      productId: "api-usdt",
      apr: 8,
      tiers: [{ min: 0, max: 300, apr: 8 }],
      fetchedAt: "2026-10-09T12:00:00.000Z",
      sourceLabel: "API",
    }],
  };
  const current = {
    rates: [{
      productId: "api-usdt",
      apr: 7,
      aprSource: "cache",
      aprFetchedAt: "2026-10-09T12:00:00.000Z",
      tiers: [{ min: 0, max: 250, apr: 7 }],
      capacitySource: "live",
      fetchedAt: observedAt,
      sourceLabel: "API",
      catalog: { asset: "USDT" },
    }],
  };

  const events = buildSyncChangeEvents(previous, current, "手动刷新", observedAt);
  assert.deepEqual(events.map((event) => event.type), ["capacity"]);
  assert.equal(events[0].before, "300.00 USDT");
  assert.equal(events[0].after, "250.00 USDT");
  assert.equal(events[0].attention, false, "an unconfirmed cached APR cannot qualify the quota change");
});

test("product history can page beyond the former global 2,000 event limit", async () => {
  const db = sqliteDb();
  const insert = db.sqlite.prepare(`INSERT INTO product_change_events
    (owner_id, event_id, product_id, change_type, title, observed_at, source, attention)
    VALUES ('user-1', ?, ?, 'rate', 'APR 调整', ?, '定时刷新', 0)`);
  for (let index = 0; index < 101; index += 1) {
    const id = String(index + 1).padStart(3, "0");
    insert.run(`event-${id}`, "product-a", new Date(Date.UTC(2026, 8, index + 1)).toISOString());
  }
  insert.run("other-product-event", "product-b", "2026-10-01T00:00:00.000Z");

  const first = await loadProductChangeEventPage(db, "user-1", "product-a", null, 50);
  const second = await loadProductChangeEventPage(db, "user-1", "product-a", first.nextCursor, 50);
  const third = await loadProductChangeEventPage(db, "user-1", "product-a", second.nextCursor, 50);
  assert.equal(first.events.length, 50);
  assert.equal(second.events.length, 50);
  assert.equal(third.events.length, 1);
  assert.equal(third.events[0].id, "event-001");
  assert.equal(third.nextCursor, null);
  assert.equal(new Set([...first.events, ...second.events, ...third.events].map((event) => event.id)).size, 101);
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

test("APR history records only first-tier changes and ignores later-tier-only changes", () => {
  const snapshot = (firstApr, laterApr) => ({
    rates: [{
      productId: "bitget-usdc-ladder",
      apr: firstApr,
      tiers: [
        { min: 0, max: 300, apr: firstApr },
        { min: 300, max: 1_000_000, apr: laterApr },
      ],
    }],
  });

  assert.deepEqual(
    buildSyncChangeEvents(snapshot(6.66, 1.73), snapshot(6.66, 1.36), "手动刷新", observedAt),
    [],
    "a change confined to the second tier does not create an APR event",
  );

  const firstTierChange = buildSyncChangeEvents(
    snapshot(6.66, 1.73),
    snapshot(6.5, 1.36),
    "手动刷新",
    observedAt,
  );
  assert.deepEqual(firstTierChange.map(({ title, before, after }) => ({ title, before, after })), [{
    title: "首档 APR 下调",
    before: "6.66%",
    after: "6.50%",
  }]);
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

  const missingMax = buildSyncChangeEvents(
    { rates: [{ productId: "api-usdt", apr: 7, tiers: [{ min: 0, max: 500, apr: 7 }] }], holdingUpdates: { "api-usdt": 700 } },
    { rates: [{ productId: "api-usdt", apr: 7, tiers: [{ min: 0, apr: 7 }], capacitySource: "live" }], holdingUpdates: { "api-usdt": 700 } },
    "定时刷新",
    observedAt,
  );
  assert.equal(missingMax.some((event) => event.attention), false);

  const unlimitedToLimited = buildSyncChangeEvents(
    { rates: [{ productId: "api-usdt", apr: 6, tiers: [{ min: 0, max: null, maxStatus: "unlimited", apr: 6 }] }] },
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
      rates: [{ productId: "api-usdt", apr: 6, tiers: [{ min: 0, max: null, maxStatus: "unlimited", apr: 6 }], capacitySource: "live", catalog: { asset: "USDT" } }],
    },
    "定时刷新",
    observedAt,
  );
  assert.deepEqual(limitedToUnlimited.map((event) => [event.before, event.after, event.attention]), [["300.00 USDT", "不限额", true]]);
});

test("a refresh records a maturity when an existing position crosses its redeem date", () => {
  const position = { productId: "fixed-usdt", positionId: "position-1", amount: 100, redeemAt: "2026-10-02T10:00:00.000Z", source: "api" };
  const events = buildSyncChangeEvents(
    { fetchedAt: "2026-10-02T09:00:00.000Z", holdingPositions: [position] },
    { fetchedAt: observedAt, holdingPositions: [position] },
    "定时刷新",
    observedAt,
  );
  assert.deepEqual(events.map((event) => event.title), ["定期已到期"]);
  assert.equal(events[0].after, "10/02");
  assert.equal(events[0].attention, true);
  const newlyDiscoveredFuturePosition = buildSyncChangeEvents(
    { fetchedAt: "2026-10-02T09:00:00.000Z", holdingPositions: [] },
    { fetchedAt: observedAt, holdingPositions: [{ ...position, redeemAt: "2026-10-05T10:00:00.000Z" }] },
    "定时刷新",
    observedAt,
  );
  assert.deepEqual(newlyDiscoveredFuturePosition, []);
});

test("APR alerts on either crossing of 6%, but not fluctuations on the same side", () => {
  const snapshot = (apr) => ({ rates: [{ productId: "api-usdt", apr, tiers: [{ min: 0, max: 500, apr }] }] });
  assert.equal(buildSyncChangeEvents(snapshot(6), snapshot(5.9), "定时刷新", observedAt)[0].attention, true);
  assert.equal(buildSyncChangeEvents(snapshot(5.9), snapshot(5), "定时刷新", observedAt)[0].attention, false);
  assert.equal(buildSyncChangeEvents(snapshot(5), snapshot(6), "定时刷新", observedAt)[0].attention, true);
  assert.equal(buildSyncChangeEvents(snapshot(6), snapshot(6.1), "定时刷新", observedAt)[0].attention, false);
  assert.equal(buildSyncChangeEvents(snapshot(6.1), snapshot(5.9), "定时刷新", observedAt)[0].attention, true);
});

test("capacity alerts only when known holdings enter over-capacity, and reset after recovery", () => {
  const snapshot = (holding, cap, holdingFallbacks = {}) => ({
    rates: [{ productId: "api-usdt", apr: 7, tiers: [{ min: 0, max: cap, apr: 7 }] }],
    holdingUpdates: { "api-usdt": holding },
    holdingFallbacks,
  });
  const entered = buildSyncChangeEvents(snapshot(450, 500), snapshot(450, 300), "定时刷新", observedAt);
  assert.equal(entered.filter((event) => event.title === "持仓超过首档额度" && event.attention).length, 1);

  const stillOver = buildSyncChangeEvents(snapshot(450, 300), snapshot(470, 300), "定时刷新", observedAt);
  assert.equal(stillOver.some((event) => event.attention), false);
  const recovered = buildSyncChangeEvents(snapshot(450, 300), snapshot(250, 300), "定时刷新", observedAt);
  assert.equal(recovered.some((event) => event.attention), false);
  const reentered = buildSyncChangeEvents(snapshot(250, 300), snapshot(450, 300), "定时刷新", observedAt);
  assert.equal(reentered.find((event) => event.attention)?.title, "持仓超过首档额度");

  const unknown = buildSyncChangeEvents(snapshot(250, 300), snapshot(450, 300, { "api-usdt": observedAt }), "定时刷新", observedAt);
  assert.equal(unknown.some((event) => event.attention), false);
  const recoveredAfterFallback = buildSyncChangeEvents(snapshot(450, 300, { "api-usdt": observedAt }), snapshot(470, 300), "定时刷新", observedAt);
  assert.equal(recoveredAfterFallback.some((event) => event.title === "持仓超过首档额度"), false);
  const newOverAfterFallback = buildSyncChangeEvents(snapshot(250, 300, { "api-usdt": observedAt }), snapshot(450, 300), "定时刷新", observedAt);
  assert.equal(newOverAfterFallback.some((event) => event.title === "持仓超过首档额度" && event.attention), true);
});

test("confirmed quota changes alert only when the new APR is at least 6%", () => {
  const snapshot = (apr, cap, extra = {}) => ({ rates: [{ productId: "p", apr, tiers: [{ min: 0, max: cap, apr }], ...extra }] });
  const changes = (before, after) => buildSyncChangeEvents(before, after, "手动刷新", observedAt);
  assert.equal(changes(snapshot(6, 300), snapshot(6, 1000))[0].attention, true);
  assert.equal(changes(snapshot(7, 300), snapshot(6, 100)).find((e) => e.type === "capacity").attention, true);
  assert.equal(changes(snapshot(6, 300), snapshot(5.9, 1000)).find((e) => e.type === "capacity").attention, false);
  assert.equal(changes(snapshot(5.9, 300), snapshot(5.9, 1000))[0].attention, false);
  assert.deepEqual(changes(snapshot(6, 300), snapshot(6, 300)), []);
  const both = changes(snapshot(5.9, 300), snapshot(6, 1000));
  assert.deepEqual(both.map((e) => [e.type, e.attention]), [["rate", true], ["capacity", true]]);
  assert.deepEqual(changes(null, snapshot(6, 1000)), []);
  assert.equal(changes(snapshot(7, 300), snapshot(7, 1000, { capacitySource: "cache" })).length, 0);
});

test("manual APR and known quota changes follow the same opportunity rules", () => {
  const product = { id: "p", asset: "USDT", productType: "flexible", productDataMode: "manual", source: { kind: "manual" }, tiers: [] };
  const settings = (apr, firstTierLimit, firstTierUnlimited = false) => ({ apr, firstTierLimit, firstTierUnlimited, termDays: null, purchaseDate: null, updatedAt: null });
  const changes = (before, after) => buildManualChangeEvents({}, {}, { p: before }, { p: after }, [], [], [product],
    { holdingProductIds: [], overrideProductIds: ["p"], manualProductIds: [], deletedManualProductIds: [] }, observedAt);
  const both = changes(settings(5.9, 300), settings(6, 1000));
  assert.deepEqual(both.map((e) => [e.type, e.attention]), [["rate", true], ["capacity", true]]);
  assert.equal(changes(settings(6, 300), settings(6, 100))[0].attention, true);
  assert.equal(changes(settings(5.9, 300), settings(5.9, 100))[0].attention, false);
  assert.equal(changes(settings(6, null), settings(6, 100))[0].attention, false);
  assert.equal(changes(settings(6, 100), settings(6, null, true))[0].attention, true);
  assert.deepEqual(changes(settings(6, 100), settings(6, 100)), []);
});

test("simultaneous opportunity changes remain one product alert until both events are read", async () => {
  const snapshot = (apr, cap) => ({ rates: [{ productId: "p", apr, tiers: [{ min: 0, max: cap, apr }] }] });
  const events = buildSyncChangeEvents(snapshot(5.9, 300), snapshot(6, 1000), "手动刷新", observedAt);
  const db = sqliteDb();
  await db.batch(prepareProductChangeEventStatements(db, "user-1", events));
  assert.deepEqual(await loadProductHistorySummaries(db, "user-1"), [{ productId: "p", eventCount: 2, unreadCount: 2 }]);
  await markProductChangeEventsRead(db, "user-1", "p", [events[0].id], observedAt);
  assert.equal((await loadProductHistorySummaries(db, "user-1"))[0].unreadCount, 1);
  await markProductChangeEventsRead(db, "user-1", "p", [events[1].id], observedAt);
  assert.equal((await loadProductHistorySummaries(db, "user-1"))[0].unreadCount, 0);
  assert.deepEqual(buildSyncChangeEvents(snapshot(6, 1000), snapshot(6, 1000), "手动刷新", observedAt), []);
  db.sqlite.close();
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
    { "manual-usdt": { apr: 5.5, firstTierLimit: 300, termDays: null, purchaseDate: null, updatedAt: observedAt } },
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

test("manual capacity alerts are transition-based and reset when holdings return below quota", () => {
  const product = {
    id: "manual-usdt",
    accountId: "binance-global",
    asset: "USDT",
    productType: "flexible",
    manualKind: "flexible",
    tiers: [{ min: 0, max: 500, apr: 7 }],
  };
  const previousOverrides = { "manual-usdt": { apr: 7, firstTierLimit: 500, termDays: null, purchaseDate: null, updatedAt: null } };
  const lowLimit = { "manual-usdt": { apr: 7, firstTierLimit: 300, termDays: null, purchaseDate: null, updatedAt: observedAt } };
  const change = (previousHoldings, nextHoldings, before, after) => buildManualChangeEvents(
    previousHoldings,
    nextHoldings,
    before,
    after,
    [product],
    [product],
    [product],
    { holdingProductIds: [], overrideProductIds: [product.id], manualProductIds: [], deletedManualProductIds: [] },
    observedAt,
  );
  const entered = change({ "manual-usdt": 450 }, { "manual-usdt": 450 }, previousOverrides, lowLimit);
  assert.equal(entered.filter((event) => event.title === "持仓超过首档额度" && event.attention).length, 1);
  const recoveredLimit = change({ "manual-usdt": 450 }, { "manual-usdt": 450 }, lowLimit, previousOverrides);
  assert.equal(recoveredLimit.some((event) => event.title === "持仓超过首档额度"), false);
  const reentered = change({ "manual-usdt": 450 }, { "manual-usdt": 450 }, previousOverrides, lowLimit);
  assert.equal(reentered.some((event) => event.attention), true);
});

test("manual fixed-term maturity produces one stable attention event while the state persists", async () => {
  const product = {
    id: "manual-fixed",
    accountId: "binance-global",
    asset: "USDT",
    productType: "fixed",
    manualKind: "fixed",
    termDays: 7,
    productDataMode: "manual",
    holdingDataMode: "manual",
  };
  const holdings = { "manual-fixed": 100 };
  const overrides = { "manual-fixed": { apr: 8, firstTierLimit: null, termDays: 7, purchaseDate: "2026-09-20", updatedAt: null } };
  const first = buildManualMaturityEvents([product], holdings, overrides, new Date("2026-10-03T06:00:00.000Z"));
  const repeated = buildManualMaturityEvents([product], holdings, overrides, new Date("2026-10-03T08:00:00.000Z"));
  assert.equal(first.length, 1);
  assert.equal(first[0].title, "定期已到期");
  assert.equal(first[0].attention, true);
  assert.equal(first[0].id, repeated[0].id);

  const db = sqliteDb();
  await db.batch(prepareProductChangeEventStatements(db, "user-1", first));
  await markProductChangeEventsRead(db, "user-1", product.id, first.map((event) => event.id), observedAt);
  await db.batch(prepareProductChangeEventStatements(db, "user-1", repeated));
  const stored = await loadProductChangeEvents(db, "user-1");
  assert.equal(stored.filter((event) => event.productId === product.id).length, 1);
  assert.equal(stored[0].readAt, observedAt);
});

test("opening history persists read state only for that owner's attention events", async () => {
  const db = sqliteDb();
  await db.prepare(`INSERT INTO product_change_events
    (owner_id, event_id, product_id, change_type, title, observed_at, source, attention)
    VALUES (?, ?, ?, 'rate', 'APR 跌破阈值', ?, '定时刷新', 1)`)
    .bind("user-1", "unread-a", "product-a", observedAt).run();
  await db.prepare(`INSERT INTO product_change_events
    (owner_id, event_id, product_id, change_type, title, observed_at, source, attention)
    VALUES (?, ?, ?, 'rate', 'APR 跌破阈值', ?, '定时刷新', 1)`)
    .bind("user-2", "unread-b", "product-a", observedAt).run();
  await db.prepare(`INSERT INTO product_change_events
    (owner_id, event_id, product_id, change_type, title, observed_at, source, attention)
    VALUES (?, ?, ?, 'holding', '持仓变化', ?, '手动编辑', 0)`)
    .bind("user-1", "ordinary", "product-a", observedAt).run();

  await markProductChangeEventsRead(db, "user-1", "product-a", ["unread-a", "ordinary", "unread-b"], observedAt);
  const mine = await loadProductChangeEvents(db, "user-1");
  const others = await loadProductChangeEvents(db, "user-2");
  assert.equal(mine.find((event) => event.id === "unread-a").readAt, observedAt);
  assert.equal(mine.find((event) => event.id === "ordinary").readAt, undefined);
  assert.equal(others.find((event) => event.id === "unread-b").readAt, undefined);
});
