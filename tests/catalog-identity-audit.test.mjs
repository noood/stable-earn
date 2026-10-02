import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

test("catalog identity audit reports duplicate identities and orphaned references without writing", async () => {
  const load = moduleLoader();
  const { auditCatalogIdentities } = load("@/lib/catalog-identity-audit");
  const db = sqliteDb();
  const now = "2026-10-02T00:00:00.000Z";
  const insertCatalog = db.sqlite.prepare(`INSERT INTO product_catalog
    (owner_id, product_id, canonical_product_id, identity_key, identity_fingerprint, payload, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const payload = (id, accountId = "bitget-global") => JSON.stringify({
    id,
    accountId,
    productDataMode: "api",
    identityKey: "same-family",
  });
  insertCatalog.run("user", "bg-current", "bg-usdt-simple", "same-family", "fingerprint-a", payload("bg-current"), "active", now, now);
  insertCatalog.run("user", "api-bg-legacy", "bg-usdt-simple", "same-family", "fingerprint-b", payload("api-bg-legacy"), "active", now, now);
  db.sqlite.prepare("INSERT INTO holdings (user_id, product_id, amount, updated_at) VALUES (?, ?, ?, ?)")
    .run("user", "missing-product", 12, now);
  db.sqlite.prepare(`INSERT INTO user_products
    (user_id, product_id, account_id, asset, product_kind, term_days, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("user", "manual-existing", "bitget-global", "USDT", "flexible", null, now, now);
  db.sqlite.prepare("INSERT INTO sync_snapshots (owner_id, cache_key, payload, updated_at) VALUES (?, ?, ?, ?)")
    .run("user", "private-products", JSON.stringify({
      products: [{ productId: "missing-cache-product" }],
      holdingUpdates: { "missing-cache-holding": 0, "manual-existing": 0 },
    }), now);

  const before = db.sqlite.prepare("SELECT COUNT(*) AS count FROM product_catalog").get().count;
  const report = await auditCatalogIdentities(db, "user");
  const after = db.sqlite.prepare("SELECT COUNT(*) AS count FROM product_catalog").get().count;

  assert.equal(report.summary.catalogRows, 2);
  assert.equal(report.summary.activeRows, 2);
  assert.equal(report.summary.duplicateIdentityGroups, 1);
  assert.equal(report.summary.generatedProductIds, 1);
  assert.equal(report.summary.orphanReferences, 3);
  assert.equal(report.summary.needsMigrationReview, true);
  assert.equal(before, after);
});
