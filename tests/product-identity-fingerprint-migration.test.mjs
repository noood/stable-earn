import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

const removeCanonical = readFileSync(new URL("../drizzle/0012_remove_canonical_product_id.sql", import.meta.url), "utf8");
const removeFingerprint = readFileSync(new URL("../drizzle/0018_remove_identity_fingerprint.sql", import.meta.url), "utf8");

test("identity fingerprint migration drops diagnostics but preserves product IDs and references", () => {
  const db = sqliteDb({ legacyIdentityFingerprint: true });
  db.sqlite.exec(removeCanonical);
  db.sqlite.exec(`CREATE UNIQUE INDEX legacy_product_fingerprint_identity
    ON product_catalog (owner_id, identity_key, identity_fingerprint)`);

  const now = "2026-10-04T00:00:00.000Z";
  const insert = db.sqlite.prepare(`INSERT INTO product_catalog
    (owner_id, product_id, identity_key, identity_fingerprint, payload, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run("user", "durable-row-7d", "exchange:USDT:fixed:offer", "{\"termDays\":7}", JSON.stringify({
    id: "durable-row-7d", identityKey: "exchange:USDT:fixed:offer", identityFingerprint: "legacy-7d",
  }), "active", now, now);
  insert.run("user", "durable-row-90d", "exchange:USDT:fixed:offer", "{\"termDays\":90}", JSON.stringify({
    id: "durable-row-90d", identityKey: "exchange:USDT:fixed:offer", identityFingerprint: "legacy-90d",
  }), "archived", now, now);
  db.sqlite.prepare("INSERT INTO holdings VALUES (?, ?, ?, ?)").run("user", "durable-row-7d", 12, now);
  db.sqlite.prepare(`INSERT INTO holding_positions
    (user_id, product_id, position_key, amount, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run("user", "durable-row-7d", "position-1", 12, "api", now);
  db.sqlite.prepare("INSERT INTO product_overrides (user_id, product_id, confirmed_apr, purchase_date, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("user", "durable-row-7d", 7, "2026-09-01", now);
  db.sqlite.prepare("INSERT INTO product_identity_aliases (owner_id, alias, product_id, created_at) VALUES (?, ?, ?, ?)")
    .run("user", "legacy-row-alias", "durable-row-7d", now);
  db.sqlite.prepare(`INSERT INTO product_change_events
    (owner_id, event_id, product_id, change_type, title, observed_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run("user", "history-1", "durable-row-7d", "holding", "持仓变化", now, "手动刷新");
  db.sqlite.prepare("INSERT INTO hidden_products VALUES (?, ?, ?)").run("user", "durable-row-90d", now);

  db.sqlite.exec(removeFingerprint);

  const columns = db.sqlite.prepare("PRAGMA table_info(product_catalog)").all().map((row) => row.name);
  assert.equal(columns.includes("identity_fingerprint"), false);
  assert.equal(columns.includes("canonical_product_id"), false);
  assert.deepEqual(db.sqlite.prepare("SELECT product_id, identity_key, status FROM product_catalog ORDER BY product_id").all().map((row) => ({ ...row })), [
    { product_id: "durable-row-7d", identity_key: "exchange:USDT:fixed:offer", status: "active" },
    { product_id: "durable-row-90d", identity_key: "exchange:USDT:fixed:offer", status: "archived" },
  ]);
  assert.deepEqual(db.sqlite.prepare("SELECT product_id, amount FROM holdings").all().map((row) => ({ ...row })), [
    { product_id: "durable-row-7d", amount: 12 },
  ]);
  assert.deepEqual(db.sqlite.prepare("SELECT product_id, position_key, amount FROM holding_positions").all().map((row) => ({ ...row })), [
    { product_id: "durable-row-7d", position_key: "position-1", amount: 12 },
  ]);
  assert.equal(db.sqlite.prepare("SELECT product_id FROM product_overrides").get().product_id, "durable-row-7d");
  assert.equal(db.sqlite.prepare("SELECT product_id FROM product_identity_aliases WHERE alias = 'legacy-row-alias'").get().product_id, "durable-row-7d");
  assert.equal(db.sqlite.prepare("SELECT product_id FROM product_change_events WHERE event_id = 'history-1'").get().product_id, "durable-row-7d");
  assert.equal(db.sqlite.prepare("SELECT product_id FROM hidden_products").get().product_id, "durable-row-90d");
});
