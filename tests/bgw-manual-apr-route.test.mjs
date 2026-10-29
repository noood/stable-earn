import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

const savedAt = "2026-10-29T00:00:00.000Z";

async function fixture() {
  const db = sqliteDb();
  let currentUser = "alice";
  const load = moduleLoader({
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/db": { getDatabase: async () => db, getUserId: async () => currentUser },
    "@/lib/local-preview": { isLocalPreviewRequest: () => false },
    "@/lib/sync-diagnostics": { syncDiagnostic() {} },
  });
  const walletRate = load("@/lib/bitget-wallet-product").bitgetWalletRate();
  let product;
  for (const [owner, amount] of [["alice", 123.456789], ["bob", 25]]) {
    const catalog = await load("@/lib/product-catalog").prepareProductCatalogSync(db, owner, [walletRate], { [walletRate.productId]: amount });
    assert.equal(catalog.products.length, 1);
    await db.batch(catalog.statements);
    product = catalog.products[0];
    assert.equal(product.productDataMode, "manual");
    assert.equal(product.holdingDataMode, "api");
    assert.equal(product.capacityStatus, "available");
    assert.equal(product.tierStructureStatus, "complete");
    assert.equal(product.tiers[0].max, null);
    assert.equal(product.tiers[0].maxStatus, "unlimited");
    db.sqlite.prepare("INSERT INTO holdings VALUES (?,?,?,?)").run(owner, product.id, amount, savedAt);
    db.sqlite.prepare(`INSERT INTO sync_snapshots (owner_id,cache_key,payload,updated_at)
      VALUES (?,'private-products',?,?)`).run(owner, JSON.stringify({
      products: [product], holdingUpdates: { [product.id]: amount },
      holdingSyncStates: { [product.id]: "synced" }, holdingFallbacks: {},
    }), savedAt);
  }
  const route = load("@/app/private/api/holdings/route");
  const request = (payload) => new Request("https://test/private/api/holdings", {
    method: "PUT", headers: { origin: "https://test", "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  return {
    db, load, route, product, request,
    user(value) { currentUser = value; },
    save(apr, extraOverride = {}, extraPayload = {}) {
      return route.PUT(request({ holdings: {}, changedHoldingProductIds: [], changedOverrideProductIds: [product.id],
        overrides: { [product.id]: { apr, ...extraOverride } }, ...extraPayload }));
    },
    async read() { return (await route.GET(new Request("https://test/private/api/holdings"))).json(); },
    savedApr(owner = currentUser) { return db.sqlite.prepare("SELECT confirmed_apr FROM product_overrides WHERE user_id=? AND product_id=?").get(owner, product.id)?.confirmed_apr; },
    savedHolding(owner = currentUser) { return db.sqlite.prepare("SELECT amount,updated_at FROM holdings WHERE user_id=? AND product_id=?").get(owner, product.id); },
    close() { db.sqlite.close(); },
  };
}

test("manual BGW APR round-trips through confirmed_apr without changing current API holdings", async () => {
  const f = await fixture();
  try {
    const before = await f.read();
    assert.equal(before.overrides[f.product.id], undefined);
    assert.equal(before.holdings[f.product.id], 123.456789);
    assert.equal((await f.save(6.72)).status, 200);
    const after = await f.read();
    assert.equal(after.overrides[f.product.id].apr, 6.72);
    assert.equal(f.savedApr(), 6.72);
    assert.equal(after.holdings[f.product.id], 123.456789);
    assert.equal(f.savedHolding().amount, 123.456789);
    assert.equal(f.savedHolding().updated_at, savedAt);
    const resolved = f.load("@/lib/product-overrides").applyProductOverride(after.products[0], after.overrides[f.product.id]);
    assert.equal(resolved.rateCoverage, "complete");
    assert.equal(resolved.tiers[0].apr, 6.72);
    assert.equal(resolved.holdingDataMode, "api");
    const effectiveApr = f.load("@/lib/domain").effectiveApr(resolved, 1000);
    assert.equal(effectiveApr, 6.72);
    assert.equal(f.load("@/lib/opportunity-policy").highestProductApr(resolved), 6.72);
    const estimatedDailyYield = 1000 * effectiveApr / 100 / 365;
    assert.ok(Math.abs(estimatedDailyYield - 0.1841095890410959) < 1e-12);
  } finally { f.close(); }
});

test("BGW APR edits and reads remain scoped to the signed-in user", async () => {
  const f = await fixture();
  try {
    await f.save(6.72, {}, { userId: "bob" });
    assert.equal(f.savedApr("alice"), 6.72);
    assert.equal(f.savedApr("bob"), undefined);
    f.user("bob");
    const bobBefore = await f.read();
    assert.equal(bobBefore.overrides[f.product.id], undefined);
    assert.equal(bobBefore.holdings[f.product.id], 25);
    assert.equal((await f.save(1.25)).status, 200);
    assert.equal((await f.read()).overrides[f.product.id].apr, 1.25);
    assert.equal(f.savedApr("alice"), 6.72);
    assert.equal(f.savedHolding("alice").amount, 123.456789);
    f.user("alice");
    assert.equal((await f.read()).overrides[f.product.id].apr, 6.72);
    assert.equal(f.savedHolding("bob").amount, 25);
  } finally { f.close(); }
});

test("zero BGW APR is a valid known value and clearing returns to APR pending", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.save(0)).status, 200);
    let read = await f.read();
    let resolved = f.load("@/lib/product-overrides").applyProductOverride(read.products[0], read.overrides[f.product.id]);
    assert.equal(f.savedApr(), 0);
    assert.equal(resolved.rateCoverage, "complete");
    assert.equal(resolved.aprStatus, "available");
    assert.equal(resolved.tiers[0].apr, 0);
    assert.deepEqual(f.load("@/lib/product-status").productInformationIssues(resolved, read.overrides[f.product.id]), []);
    for (const empty of [null, ""]) {
      assert.equal((await f.save(empty)).status, 200);
      read = await f.read();
      resolved = f.load("@/lib/product-overrides").applyProductOverride(read.products[0], read.overrides[f.product.id]);
      assert.equal(read.overrides[f.product.id].apr, null);
      assert.equal(f.savedApr(), null);
      assert.equal(resolved.rateCoverage, "unavailable");
      assert.equal(resolved.aprStatus, "unavailable");
      assert.deepEqual(f.load("@/lib/product-status").productInformationIssues(resolved, read.overrides[f.product.id]), ["APR 待填写"]);
      assert.equal(f.load("@/lib/product-rate-presentation").rateHeadlineFor(resolved).value, "APR 待填写");
      assert.equal(f.savedHolding().amount, 123.456789);
    }
  } finally { f.close(); }
});

test("a crafted APR override cannot alter the wallet balance, subscription capacity or product type", async () => {
  const f = await fixture();
  try {
    const accepted = await f.save(6.72, { firstTierLimit: 999999, termDays: 365, purchaseDate: "2026-01-01", manualKind: "fixed" });
    assert.equal(accepted.status, 200);
    const read = await f.read();
    const override = read.overrides[f.product.id];
    assert.equal(override.apr, 6.72);
    assert.equal(override.firstTierLimit, null);
    assert.equal(override.termDays, null);
    assert.equal(override.purchaseDate, null);
    assert.equal(override.manualKind, null);
    assert.equal(read.products[0].productType, "flexible");
    assert.equal(read.products[0].tiers[0].max, null);
    assert.equal(read.products[0].tiers[0].maxStatus, "unlimited");
    assert.equal(read.products[0].capacityStatus, "available");
    for (const badAmount of [0, 999, null]) {
      const rejected = await f.save(7.5, {}, { holdings: { [f.product.id]: badAmount }, changedHoldingProductIds: [f.product.id] });
      assert.equal(rejected.status, 400);
      assert.equal(f.savedApr(), 6.72);
      assert.equal(f.savedHolding().amount, 123.456789);
    }
  } finally { f.close(); }
});

test("malformed manual BGW APR is rejected without clearing the saved value", async () => {
  const f = await fixture();
  try {
    await f.save(6.72);
    for (const bad of [true, [], {}, -1, 10001, "6.72garbage", "Infinity"]) {
      assert.equal((await f.save(bad)).status, 400);
      assert.equal(f.savedApr(), 6.72);
      assert.equal(f.savedHolding().amount, 123.456789);
    }
  } finally { f.close(); }
});

test("manual BGW APR history names APR and distinguishes pending from a known zero", async () => {
  const f = await fixture();
  try {
    const initial = await f.save(6.72);
    assert.equal(initial.status, 200);
    let changes = (await initial.json()).changeEvents.filter((event) => event.type === "rate");
    assert.equal(changes.length, 1);
    assert.equal(changes[0].title, "APR 修改");
    assert.equal(changes[0].before, "待填写");
    assert.equal(changes[0].after, "6.72%");
    await f.save(0);
    const cleared = await f.save(null);
    assert.equal(cleared.status, 200);
    changes = (await cleared.json()).changeEvents.filter((event) => event.type === "rate");
    assert.ok(changes.every((event) => event.title === "APR 修改"));
    assert.ok(changes.some((event) => event.before === "6.72%" && event.after === "0.00%"));
    assert.ok(changes.some((event) => event.before === "0.00%" && event.after === "待填写"));
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM product_change_events WHERE change_type='holding'").get().n, 0);
    f.user("bob");
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM product_change_events WHERE owner_id='bob'").get().n, 0);
  } finally { f.close(); }
});
