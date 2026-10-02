import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

test("Bitget platform identities reuse the migrated row for the matching offer", async () => {
  const load = moduleLoader();
  const { previewProducts } = load("@/lib/preview-fixtures");
  const { prepareProductCatalogSync } = load("@/lib/product-catalog");
  const db = sqliteDb();
  const seed = previewProducts.find((product) => product.id === "bg-usdt-simple");
  const legacy = {
    ...seed,
    identityKey: "bitget-global:USDT:flexible:bg-usdt-standard",
    externalProductId: "bg-usdt-standard",
    productDataMode: "api",
    apiAccess: "authenticated",
  };
  const now = "2026-10-02T00:00:00.000Z";
  db.sqlite.prepare(`INSERT INTO product_catalog
    (owner_id, product_id, canonical_product_id, identity_key, identity_fingerprint, payload, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
    .run("user", legacy.id, legacy.identityKey, legacy.identityKey, legacy.identityFingerprint ?? null, JSON.stringify(legacy), now, now);
  db.sqlite.prepare("INSERT INTO holdings (user_id, product_id, amount, updated_at) VALUES (?, ?, ?, ?)")
    .run("user", legacy.id, 300, now);

  const rate = (externalProductId, max, apr) => ({
    productId: `bitget-global:USDT:flexible:${externalProductId}`,
    canonicalProductId: `bitget-global:USDT:flexible:${externalProductId}`,
    externalProductId,
    identityKey: `bitget-global:USDT:flexible:${externalProductId}`,
    identityFingerprint: '{"productType":"flexible","termDays":null}',
    apr,
    tiers: [{ min: 0, max, apr }],
    fetchedAt: now,
    sourceLabel: "Bitget 官方账户产品 API",
    catalog: { accountId: "bitget-global", exchange: "bitget", region: "global", asset: "USDT", holdingDataMode: "api", apiAccess: "authenticated" },
  });
  const result = await prepareProductCatalogSync(db, "user", [
    rate("bg-usdt-standard", 300, 8.06),
    rate("bg-usdt-promo", 100000, 10),
  ], { "bg-usdt-standard": 300, "bg-usdt-promo": 0 });

  assert.equal(result.rates.length, 2);
  assert.equal(result.rates[0].productId, legacy.id);
  assert.notEqual(result.rates[1].productId, legacy.id);
  assert.equal(result.products.length, 2);
});

test("partial holding sync does not archive an active product after an APR drop", async () => {
  const load = moduleLoader();
  const { prepareProductCatalogSync } = load("@/lib/product-catalog");
  const db = sqliteDb();
  const now = "2026-10-02T00:00:00.000Z";
  const product = {
    id: "api-bitget-usdt",
    accountId: "bitget-global",
    exchange: "bitget",
    region: "global",
    asset: "USDT",
    name: "Simple Earn",
    productDataMode: "api",
    apiAccess: "authenticated",
    holdingDataMode: "api",
    productType: "flexible",
    tiers: [{ id: "api-bitget-usdt-tier-0", min: 0, max: 300, apr: 8 }],
    source: { kind: "live", label: "Bitget", fetchedAt: now },
    rateCoverage: "complete",
    externalProductId: "bg-usdt-standard",
    identityKey: "bitget-global:USDT:flexible:bg-usdt-standard",
  };
  db.sqlite.prepare(`INSERT INTO product_catalog
    (owner_id, product_id, canonical_product_id, identity_key, identity_fingerprint, payload, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
    .run("user", product.id, product.identityKey, product.identityKey, null, JSON.stringify(product), now, now);
  db.sqlite.prepare("INSERT INTO holdings (user_id, product_id, amount, updated_at) VALUES (?, ?, ?, ?)")
    .run("user", product.id, 0, now);

  const result = await prepareProductCatalogSync(db, "user", [{
    productId: product.identityKey,
    identityKey: product.identityKey,
    canonicalProductId: product.identityKey,
    externalProductId: product.externalProductId,
    apr: 5,
    tiers: [{ min: 0, max: 300, apr: 5 }],
    fetchedAt: "2026-10-02T01:00:00.000Z",
    sourceLabel: "Bitget",
    catalog: { accountId: "bitget-global", exchange: "bitget", region: "global", asset: "USDT", holdingDataMode: "api", apiAccess: "authenticated" },
  }], {}, []);

  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].id, product.id);
  await db.batch(result.statements);
  assert.equal(db.sqlite.prepare("SELECT status FROM product_catalog WHERE product_id = ?").get(product.id).status, "active");
});
