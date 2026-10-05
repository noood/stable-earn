import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

const migrationSql = readFileSync(new URL("../drizzle/0010_platform_product_identity.sql", import.meta.url), "utf8");

function insertCatalog(db, { owner = "user", id, identity, payload, status = "active" }) {
  const now = "2026-10-02T00:00:00.000Z";
  db.sqlite.prepare(`INSERT INTO product_catalog
    (owner_id, product_id, canonical_product_id, identity_key, identity_fingerprint, payload, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(owner, id, identity, identity, "{\"productType\":\"flexible\"}", JSON.stringify(payload), status, now, now);
}

function apiPayload(id, externalProductId) {
  return {
    id,
    accountId: "bitget-global",
    exchange: "bitget",
    region: "global",
    asset: "USDT",
    productType: "flexible",
    productDataMode: "api",
    apiAccess: "authenticated",
    holdingDataMode: "api",
    externalProductId,
    identityKey: `bg-usdt-simple:${externalProductId}`,
    source: { kind: "live", label: "test" },
    tiers: [{ id: `${id}-tier-0`, min: 0, max: 300, apr: 8 }],
  };
}

test("platform identity migration keeps Bitget offers and zero balances separate", () => {
  const db = sqliteDb({ legacyIdentityFingerprint: true });
  const now = "2026-10-02T00:00:00.000Z";
  insertCatalog(db, { id: "bg-usdt-simple", identity: "bg-usdt-simple", payload: apiPayload("bg-usdt-simple", "964334561256718336") });
  insertCatalog(db, { id: "api-bg-usdt-simple-1gd23qx", identity: "bg-usdt-simple:1488775596992425984", payload: apiPayload("api-bg-usdt-simple-1gd23qx", "1488775596992425984") });
  db.sqlite.prepare("INSERT INTO holdings VALUES (?, ?, ?, ?)").run("user", "bg-usdt-simple", 0, now);
  db.sqlite.prepare("INSERT INTO holdings VALUES (?, ?, ?, ?)").run("user", "api-bg-usdt-simple-1gd23qx", 170.19340326, now);
  insertCatalog(db, {
    id: "manual-12345678",
    identity: "manual-12345678",
    payload: { id: "manual-12345678", accountId: "bitget-global", asset: "USDT", productType: "flexible", productDataMode: "manual", identityKey: "manual-12345678" },
  });

  db.sqlite.exec(migrationSql);

  const rows = db.sqlite.prepare("SELECT product_id, identity_key, status, json_extract(payload, '$.identityKey') AS payload_identity FROM product_catalog ORDER BY product_id").all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { product_id: "api-bg-usdt-simple-1gd23qx", identity_key: "bitget-global:USDT:flexible:1488775596992425984", status: "active", payload_identity: "bitget-global:USDT:flexible:1488775596992425984" },
    { product_id: "bg-usdt-simple", identity_key: "bitget-global:USDT:flexible:964334561256718336", status: "active", payload_identity: "bitget-global:USDT:flexible:964334561256718336" },
    { product_id: "manual-12345678", identity_key: "manual-12345678", status: "active", payload_identity: "manual-12345678" },
  ]);
  assert.deepEqual(db.sqlite.prepare("SELECT product_id, amount FROM holdings ORDER BY product_id").all().map((row) => ({ ...row })), [
    { product_id: "api-bg-usdt-simple-1gd23qx", amount: 170.19340326 },
    { product_id: "bg-usdt-simple", amount: 0 },
  ]);
});

test("platform identity migration merges only duplicate target identities", () => {
  const db = sqliteDb({ legacyIdentityFingerprint: true });
  const now = "2026-10-02T00:00:00.000Z";
  insertCatalog(db, { id: "legacy-a", identity: "bn-g-usdt", payload: {
    ...apiPayload("legacy-a", "flex-1"), accountId: "binance-global", exchange: "binance", identityKey: "bn-g-usdt:flex-1",
  } });
  insertCatalog(db, { id: "legacy-b", identity: "bn-g-usdt:old", payload: {
    ...apiPayload("legacy-b", "flex-1"), accountId: "binance-global", exchange: "binance", identityKey: "bn-g-usdt:old",
  } });
  db.sqlite.prepare("INSERT INTO holdings VALUES (?, ?, ?, ?)").run("user", "legacy-a", 2, now);
  db.sqlite.prepare("INSERT INTO holdings VALUES (?, ?, ?, ?)").run("user", "legacy-b", 3, now);

  db.sqlite.exec(migrationSql);

  assert.deepEqual(db.sqlite.prepare("SELECT product_id, identity_key, status FROM product_catalog ORDER BY product_id").all().map((row) => ({ ...row })), [
    { product_id: "legacy-a", identity_key: "binance-global:USDT:flexible:flex-1", status: "active" },
    { product_id: "legacy-b", identity_key: "legacy-0010:legacy-b", status: "archived" },
  ]);
  assert.deepEqual(db.sqlite.prepare("SELECT product_id, amount FROM holdings").all().map((row) => ({ ...row })), [
    { product_id: "legacy-a", amount: 5 },
  ]);
});
