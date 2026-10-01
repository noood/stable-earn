import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

test("Bitget legacy family row follows the matching held offer during catalog split", async () => {
  const load = moduleLoader();
  const { seedProducts } = load("@/lib/seed-data");
  const { prepareProductCatalogSync } = load("@/lib/product-catalog");
  const db = sqliteDb();
  const legacy = seedProducts.find((product) => product.id === "bg-usdt-simple");
  const now = "2026-10-02T00:00:00.000Z";
  db.sqlite.prepare(`INSERT INTO product_catalog
    (owner_id, product_id, canonical_product_id, identity_key, identity_fingerprint, payload, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
    .run("user", legacy.id, legacy.id, legacy.identityKey, legacy.identityFingerprint ?? null, JSON.stringify(legacy), now, now);
  db.sqlite.prepare("INSERT INTO holdings (user_id, product_id, amount, updated_at) VALUES (?, ?, ?, ?)")
    .run("user", legacy.id, 300, now);

  const rate = (externalProductId, max, apr) => ({
    productId: "bg-usdt-simple",
    canonicalProductId: "bg-usdt-simple",
    externalProductId,
    identityKey: `bg-usdt-simple:${externalProductId}`,
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
