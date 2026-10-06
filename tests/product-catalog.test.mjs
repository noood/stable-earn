import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

const load = moduleLoader();
const { archiveApiCatalogProducts, prepareProductCatalogSync, resolveCatalogProductIds } = load("@/lib/product-catalog");

test("an existing API product keeps its row and marks APR unavailable after a complete field-empty response", async () => {
  const db = sqliteDb();
  const product = load("@/lib/local-preview").localPrivateProductsPreview().products
    .find((item) => item.id === "bn-g-usdt");
  assert.ok(product);
  const now = "2026-10-06T00:00:00.000Z";
  db.sqlite.prepare(`INSERT INTO product_catalog
    (owner_id, product_id, canonical_product_id, identity_key, payload, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`)
    .run("user", product.id, product.identityKey, product.identityKey, JSON.stringify(product), now, now);
  const result = await prepareProductCatalogSync(db, "user", [{
    productId: product.identityKey, identityKey: product.identityKey,
    externalProductId: product.externalProductId, apr: 0, tiers: [], rateCoverage: "unavailable",
    fetchedAt: now, sourceLabel: "Binance API", productType: product.productType,
    catalog: { accountId: product.accountId, exchange: product.exchange, region: product.region,
      asset: product.asset, holdingDataMode: "api", apiAccess: "authenticated" },
  }], { [product.identityKey]: 0 });
  const kept = result.products.find((item) => item.id === product.id);
  assert.ok(kept);
  assert.equal(kept.rateCoverage, "unavailable");
  assert.equal(kept.productDataMode, "api");
});

test("a complete supported scope cannot zero or archive an unsupported sibling scope", async () => {
  const { createProductTemplate } = load("@/lib/product-template");
  const db = sqliteDb();
  const now = "2026-10-03T00:00:00.000Z";
  const unsupportedScopeProduct = {
    ...createProductTemplate(
      "bybit-usdgo-flexible-legacy",
      "bybit-global",
      "bybit",
      "global",
      "USDGO",
      "Legacy flexible row",
      [[0, null, 5]],
      { kind: "live", label: "API", fetchedAt: now },
      { productDataMode: "api", apiAccess: "authenticated", holdingDataMode: "api" },
    ),
    externalProductId: "legacy-product",
  };
  db.sqlite.prepare(`INSERT INTO product_catalog
    (owner_id, product_id, canonical_product_id, identity_key, payload, status, first_seen_at, last_seen_at)
    VALUES ('user', ?, ?, ?, ?, 'active', ?, ?)`)
    .run(unsupportedScopeProduct.id, unsupportedScopeProduct.identityKey, unsupportedScopeProduct.identityKey,
      JSON.stringify(unsupportedScopeProduct), now, now);
  db.sqlite.prepare(`INSERT INTO holdings (user_id, product_id, amount, updated_at)
    VALUES ('user', ?, 42, ?)`)
    .run(unsupportedScopeProduct.id, now);

  const { products, statements } = await prepareProductCatalogSync(
    db,
    "user",
    [],
    {},
    [],
    ["bybit-global:USDT:flexible"],
  );

  assert.deepEqual(products.map((product) => product.id), [unsupportedScopeProduct.id]);
  assert.deepEqual(statements, []);
  assert.equal(db.sqlite.prepare("SELECT status FROM product_catalog WHERE product_id = ?")
    .get(unsupportedScopeProduct.id).status, "active");
  assert.equal(db.sqlite.prepare("SELECT amount FROM holdings WHERE product_id = ?")
    .get(unsupportedScopeProduct.id).amount, 42);
});

test("removing API credentials archives every account API product but preserves its data", async () => {
  const db = sqliteDb();
  const now = "2026-10-03T00:00:00.000Z";
  const insertProduct = db.sqlite.prepare(`INSERT INTO product_catalog
    (owner_id, product_id, canonical_product_id, identity_key, payload, status, first_seen_at, last_seen_at)
    VALUES ('user', ?, ?, ?, ?, 'active', ?, ?)`);
  const payload = (id) => JSON.stringify({
    id,
    accountId: "binance-global",
    productDataMode: "api",
    apiAccess: "authenticated",
  });
  for (const id of ["known-zero", "unknown", "position-positive", "cached-zero", "cached-positive", "stale-cache-zero"]) {
    insertProduct.run(id, id, id, payload(id), now, now);
  }
  insertProduct.run("other-account", "other-account", "other-account", JSON.stringify({
    id: "other-account", accountId: "binance-bahrain", productDataMode: "api", apiAccess: "authenticated",
  }), now, now);
  insertProduct.run("manual-product", "manual-product", "manual-product", JSON.stringify({
    id: "manual-product", accountId: "binance-global", productDataMode: "manual", apiAccess: "authenticated",
  }), now, now);
  insertProduct.run("public-product", "public-product", "public-product", JSON.stringify({
    id: "public-product", accountId: "binance-global", productDataMode: "api", apiAccess: "public",
  }), now, now);
  db.sqlite.prepare("INSERT INTO holdings (user_id, product_id, amount, updated_at) VALUES ('user', 'known-zero', 0, ?)").run(now);
  db.sqlite.prepare("INSERT INTO holdings (user_id, product_id, amount, updated_at) VALUES ('user', 'unknown', 25, ?)").run(now);
  db.sqlite.prepare("INSERT INTO holding_positions (user_id, product_id, position_key, amount, source, updated_at) VALUES ('user', 'position-positive', 'position-1', 100, 'api', ?)").run(now);
  db.sqlite.prepare(`INSERT INTO sync_snapshots (owner_id, cache_key, payload, updated_at)
    VALUES ('user', 'private-products', ?, ?)`)
    .run(JSON.stringify({
      holdingUpdates: { "cached-zero": 0, "cached-positive": 20, "stale-cache-zero": 0 },
      holdingFallbacks: { "stale-cache-zero": now },
      holdingPositions: [],
    }), now);

  db.sqlite.prepare(`INSERT INTO product_change_events
    (owner_id, event_id, product_id, change_type, title, observed_at, source, attention)
    VALUES ('user', 'history-1', 'position-positive', 'holding', '持仓变化', ?, '定时刷新', 0)`).run(now);

  await archiveApiCatalogProducts(db, "user", "binance-global");
  const statuses = Object.fromEntries(db.sqlite.prepare("SELECT product_id, status FROM product_catalog ORDER BY product_id").all()
    .map((row) => [row.product_id, row.status]));
  assert.deepEqual(statuses, {
    "known-zero": "archived",
    "cached-zero": "archived",
    "cached-positive": "archived",
    "manual-product": "active",
    "other-account": "active",
    "position-positive": "archived",
    "public-product": "archived",
    "stale-cache-zero": "archived",
    "unknown": "archived",
  });
  assert.deepEqual(db.sqlite.prepare("SELECT product_id, amount FROM holdings ORDER BY product_id").all().map((row) => ({ ...row })), [
    { product_id: "known-zero", amount: 0 },
    { product_id: "unknown", amount: 25 },
  ]);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM holding_positions WHERE product_id = 'position-positive'").get().count, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM product_change_events WHERE event_id = 'history-1'").get().count, 1);
});

test("Binance upstream aliases retain account scope when two accounts reuse one project ID", async () => {
  const { previewProducts } = moduleLoader()("@/lib/preview-fixtures");
  const db = sqliteDb();
  const now = "2026-10-03T00:00:00.000Z";
  const insert = db.sqlite.prepare(`INSERT INTO product_catalog
    (owner_id, product_id, canonical_product_id, identity_key, payload, status, first_seen_at, last_seen_at)
    VALUES ('user', ?, ?, ?, ?, 'active', ?, ?)`);
  for (const [id, accountId, region] of [
    ["global-row", "binance-global", "global"],
    ["bahrain-row", "binance-bahrain", "bahrain"],
  ]) {
    const identityKey = `${accountId}:USDT:fixed:shared-project`;
    const seed = previewProducts.find((product) => product.accountId === accountId && product.asset === "USDT");
    assert.ok(seed, `expected a preview product for ${accountId}`);
    insert.run(id, identityKey, identityKey, JSON.stringify({
      ...seed,
      id,
      accountId,
      asset: "USDT",
      externalProductId: "shared-project",
      productDataMode: "api",
      apiAccess: "authenticated",
      productType: "fixed",
      region,
    }), now, now);
  }
  const ids = await resolveCatalogProductIds(db, "user");
  assert.equal(ids["api:binance-global:USDT:shared-project"], "global-row");
  assert.equal(ids["api:binance-bahrain:USDT:shared-project"], "bahrain-row");
});
