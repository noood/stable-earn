import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

test("manual identity uses account, asset, type and a stable slug", () => {
  const { buildManualProductIdentity } = moduleLoader()("@/lib/product-identity");
  assert.equal(buildManualProductIdentity({ accountId: "mexc-uk", asset: "usdt", productType: "flexible", slug: "manual-ABC 123" }), "mexc-uk:USDT:flexible:manual:manual-abc-123");
  assert.equal(buildManualProductIdentity({ accountId: "bybit-eu", asset: "USDC", productType: "fixed", slug: "7 days" }), "bybit-eu:USDC:fixed:manual:7-days");
});

test("manual catalog migration preserves old aliases and rewrites the embedded identity", () => {
  const migrationSql = readFileSync(new URL("../drizzle/0011_manual_identity_aliases.sql", import.meta.url), "utf8");
  const db = sqliteDb();
  const now = "2026-10-02T00:00:00.000Z";
  const payload = JSON.stringify({
    id: "manual-abc12345",
    accountId: "mexc-uk",
    asset: "USDT",
    productType: "flexible",
    productDataMode: "manual",
    identityKey: "manual-abc12345",
  });
  db.sqlite.prepare(`INSERT INTO product_catalog
    (owner_id, product_id, canonical_product_id, identity_key, identity_fingerprint, payload, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
    .run("user", "manual-abc12345", "manual-abc12345", "manual-abc12345", null, payload, now, now);
  db.sqlite.exec(migrationSql);
  const row = db.sqlite.prepare("SELECT identity_key, json_extract(payload, '$.identityKey') AS payload_identity FROM product_catalog").get();
  assert.equal(row.identity_key, "mexc-uk:USDT:flexible:manual:abc12345");
  assert.equal(row.payload_identity, row.identity_key);
  assert.equal(db.sqlite.prepare("SELECT product_id FROM product_identity_aliases WHERE alias = ?").get("manual-abc12345").product_id, "manual-abc12345");
});

test("manual identity repair maps legacy account-asset ids to the default slug", () => {
  const migrationSql = readFileSync(new URL("../drizzle/0016_repair_manual_identity_aliases.sql", import.meta.url), "utf8");
  const db = sqliteDb();
  const now = "2026-10-02T00:00:00.000Z";
  const insert = db.sqlite.prepare(`INSERT INTO product_catalog
    (owner_id, product_id, canonical_product_id, identity_key, identity_fingerprint, payload, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`);
  for (const [id, accountId, asset] of [
    ["mexc-ph-usdt", "mexc-ph", "USDT"],
    ["okx-usdt", "okx", "USDT"],
  ]) {
    insert.run("user", id, id, id, null, JSON.stringify({
      id, accountId, asset, productType: "flexible", productDataMode: "manual", identityKey: id,
    }), now, now);
  }
  db.sqlite.exec(migrationSql);
  const rows = db.sqlite.prepare("SELECT product_id, identity_key FROM product_catalog ORDER BY product_id").all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { product_id: "mexc-ph-usdt", identity_key: "mexc-ph:USDT:flexible:manual:default" },
    { product_id: "okx-usdt", identity_key: "okx:USDT:flexible:manual:default" },
  ]);
  assert.equal(db.sqlite.prepare("SELECT product_id FROM product_identity_aliases WHERE alias = ?").get("mexc-ph-usdt").product_id, "mexc-ph-usdt");
});

test("canonical column migration keeps aliases and removes only the obsolete column", () => {
  const aliasesSql = readFileSync(new URL("../drizzle/0011_manual_identity_aliases.sql", import.meta.url), "utf8");
  const dropSql = readFileSync(new URL("../drizzle/0012_remove_canonical_product_id.sql", import.meta.url), "utf8");
  const db = sqliteDb();
  const now = "2026-10-02T00:00:00.000Z";
  const payload = JSON.stringify({ id: "api-example", accountId: "bybit-global", asset: "USDT", productType: "flexible", productDataMode: "api", identityKey: "old-family" });
  db.sqlite.prepare(`INSERT INTO product_catalog
    (owner_id, product_id, canonical_product_id, identity_key, identity_fingerprint, payload, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
    .run("user", "api-example", "old-family", "old-family", null, payload, now, now);
  db.sqlite.exec(aliasesSql);
  db.sqlite.exec(dropSql);
  const columns = db.sqlite.prepare("PRAGMA table_info(product_catalog)").all().map((row) => row.name);
  assert.equal(columns.includes("canonical_product_id"), false);
  assert.equal(db.sqlite.prepare("SELECT product_id FROM product_identity_aliases WHERE alias = ?").get("old-family").product_id, "api-example");
});
