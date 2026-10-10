import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

function fixture({ savedAmount = 0, snapshotAmount = 50, mixedSource = false, manualCatalog = false } = {}) {
  const db = sqliteDb();
  const load = moduleLoader({
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/db": { getDatabase: async () => db, getUserId: async () => "user" },
    "@/lib/request-security": { isSameOriginMutation: () => true, privateResponseHeaders: {} },
    "@/lib/local-preview": { isLocalPreviewRequest: () => false },
  });
  const previewProduct = moduleLoader()("@/lib/local-preview").localPrivateProductsPreview().products
    .find((item) => item.id === "bn-g-usdt");
  const product = mixedSource || manualCatalog
    ? { ...previewProduct, productDataMode: "manual", holdingDataMode: manualCatalog ? "manual" : "api" }
    : previewProduct;
  assert.ok(product);
  const time = "2026-10-06T00:00:00.000Z";
  db.sqlite.prepare(`INSERT INTO product_catalog
    (owner_id, product_id, canonical_product_id, identity_key, payload, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`)
    .run("user", product.id, product.identityKey, product.identityKey, JSON.stringify(product), time, time);
  db.sqlite.prepare("INSERT INTO holdings (user_id, product_id, amount, updated_at) VALUES (?, ?, ?, ?)")
    .run("user", product.id, savedAmount, time);
  db.sqlite.prepare("INSERT INTO sync_snapshots (owner_id, cache_key, payload, updated_at) VALUES (?, 'private-products', ?, ?)")
    .run("user", JSON.stringify({ holdingUpdates: { [product.id]: snapshotAmount }, holdingSyncStates: { [product.id]: "synced" } }), time);
  const route = load("@/app/private/api/holdings/route");
  const request = (payload) => new Request("https://local.test/private/api/holdings", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  const amount = () => db.sqlite.prepare("SELECT amount FROM holdings WHERE user_id = 'user' AND product_id = ?")
    .get(product.id).amount;
  return { db, product, route, request, amount };
}

test("a newer positive API snapshot prevents hiding a product whose saved amount is stale zero", async () => {
  const f = fixture();
  const response = await f.route.PUT(f.request({ holdings: {}, changedHoldingProductIds: [], hiddenProductIds: [f.product.id] }));
  assert.equal(response.status, 409);
  assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM hidden_products").get().count, 0);
  f.db.sqlite.prepare("INSERT INTO hidden_products (user_id, product_id, hidden_at) VALUES (?, ?, ?)")
    .run("user", f.product.id, "2026-10-06T00:00:00.000Z");
  const read = await f.route.GET(new Request("https://local.test/private/api/holdings"));
  assert.deepEqual((await read.json()).hiddenProductIds, []);
});

test("a catalogue product with manual APR and API holdings cannot hide a positive or unknown API holding", async () => {
  const positive = fixture({ mixedSource: true, savedAmount: 100, snapshotAmount: 100 });
  const hide = { holdings: {}, changedHoldingProductIds: [], hiddenProductIds: [positive.product.id] };
  assert.equal((await positive.route.PUT(positive.request(hide))).status, 409);
  assert.equal(positive.db.sqlite.prepare("SELECT COUNT(*) AS count FROM hidden_products").get().count, 0);

  const unknown = fixture({ mixedSource: true });
  unknown.db.sqlite.prepare("UPDATE sync_snapshots SET payload = '{}'").run();
  assert.equal((await unknown.route.PUT(unknown.request(hide))).status, 409);
});

test("a manual-data catalogue row can be hidden only after its saved holding reaches zero", async () => {
  const positive = fixture({ manualCatalog: true, savedAmount: 100 });
  const hide = { holdings: {}, changedHoldingProductIds: [], hiddenProductIds: [positive.product.id] };
  assert.equal((await positive.route.PUT(positive.request(hide))).status, 409);

  const zero = fixture({ manualCatalog: true, savedAmount: 0 });
  assert.equal((await zero.route.PUT(zero.request(hide))).status, 200);
  assert.equal(zero.db.sqlite.prepare("SELECT COUNT(*) AS count FROM hidden_products").get().count, 1);
});

test("a null amount cannot erase a holding, and an API amount must match its trusted snapshot", async () => {
  const f = fixture({ savedAmount: 100 });
  for (const badAmount of [null, 0, 101]) {
    const response = await f.route.PUT(f.request({ holdings: { [f.product.id]: badAmount }, changedHoldingProductIds: [f.product.id] }));
    assert.equal(response.status, 400);
    assert.equal(f.amount(), 100);
  }
  const accepted = await f.route.PUT(f.request({ holdings: { [f.product.id]: 50 }, changedHoldingProductIds: [f.product.id] }));
  assert.equal(accepted.status, 200);
  assert.equal(f.amount(), 50);
});

test("malformed override objects cannot silently clear a user's saved manual fields", async () => {
  const f = fixture({ mixedSource: true });
  f.db.sqlite.prepare(`INSERT INTO product_overrides (user_id, product_id, confirmed_apr, updated_at)
    VALUES ('user', ?, 8, '2026-10-06T00:00:00.000Z')`).run(f.product.id);
  f.db.sqlite.prepare(`INSERT INTO product_override_limits (user_id, product_id, first_tier_limit, updated_at)
    VALUES ('user', ?, 300, '2026-10-06T00:00:00.000Z')`).run(f.product.id);
  for (const raw of [null, [], true, "bad", { apr: true }, { firstTierLimit: [1] }]) {
    const response = await f.route.PUT(f.request({ holdings: {}, changedHoldingProductIds: [], changedOverrideProductIds: [f.product.id], overrides: { [f.product.id]: raw } }));
    assert.equal(response.status, 400);
    const saved = f.db.sqlite.prepare("SELECT confirmed_apr FROM product_overrides WHERE user_id = 'user' AND product_id = ?").get(f.product.id);
    const limit = f.db.sqlite.prepare("SELECT first_tier_limit FROM product_override_limits WHERE user_id = 'user' AND product_id = ?").get(f.product.id);
    assert.equal(saved.confirmed_apr, 8);
    assert.equal(limit.first_tier_limit, 300);
  }
  const cleared = await f.route.PUT(f.request({ holdings: {}, changedHoldingProductIds: [], changedOverrideProductIds: [f.product.id], overrides: { [f.product.id]: { apr: null, firstTierLimit: null } } }));
  assert.equal(cleared.status, 200);
});
