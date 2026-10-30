import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

const today = Date.parse("2026-10-20T00:00:00Z");
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [today])); }
  static now() { return today; }
}
const load = moduleLoader({ "cloudflare:workers": { env: {} } }, { Date: Clock });
const { recordDueManualMaturities } = load("@/lib/private-sync/service");

function position(db, id, { owner = "a", amount = 100, purchase = "2026-10-01", kind = "fixed", term = 7 } = {}) {
  db.sqlite.prepare(`INSERT INTO user_products
    (user_id,product_id,account_id,asset,product_kind,term_days,created_at,updated_at)
    VALUES (?,?,'binance-global','USDT',?,?,'2026-10-01','2026-10-01')`).run(owner, id, kind, term);
  db.sqlite.prepare(`INSERT INTO holdings (user_id,product_id,amount,updated_at)
    VALUES (?,?,?,'2026-10-01')`).run(owner, id, amount);
  if (purchase) db.sqlite.prepare(`INSERT INTO product_overrides
    (user_id,product_id,purchase_date,updated_at) VALUES (?,?,?,'2026-10-01')`).run(owner, id, purchase);
}

test("maturity input uses three scoped reads and does not join another owner's dates or settings", async () => {
  const db = sqliteDb();
  position(db, "shared", { purchase: "2026-10-19" });
  position(db, "shared", { owner: "b", purchase: "2026-01-01" });
  db.sqlite.prepare(`INSERT INTO product_override_terms VALUES ('b','shared',1,'2026-10-01')`).run();
  db.sqlite.prepare(`INSERT INTO product_override_limits (user_id,product_id,first_tier_limit,updated_at) VALUES ('b','shared',999,'2026-10-01')`).run();
  const queries = [];
  const wrapped = { ...db, prepare(sql) { queries.push(sql); return db.prepare(sql); } };
  assert.equal(await recordDueManualMaturities(wrapped, "a"), false);
  assert.equal(queries.length, 3);
  assert.equal(queries.filter((sql) => sql.includes("FROM holdings h")).length, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM product_change_events").get().n, 0);
  assert.equal(await recordDueManualMaturities(db, "b"), true);
  assert.deepEqual(db.sqlite.prepare("SELECT owner_id,product_id FROM product_change_events").all().map((r) => ({ ...r })), [{ owner_id: "b", product_id: "shared" }]);
  db.sqlite.close();
});

test("missing dates, zero positions, flexible products and future maturities do not produce alerts", async () => {
  const db = sqliteDb();
  position(db, "zero", { amount: 0 });
  position(db, "no-date", { purchase: null });
  position(db, "flexible", { kind: "flexible", term: null });
  position(db, "future", { purchase: "2026-10-19" });
  assert.equal(await recordDueManualMaturities(db, "a"), false);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM product_change_events").get().n, 0);
  db.sqlite.close();
});

test("catalog manual-kind/term overrides and user products keep the same maturity semantics", async () => {
  const db = sqliteDb();
  position(db, "user-due");
  const catalog = (id, mode = "manual", status = "active") => {
    const product = {
      id, identityKey: id, accountId: "okx-global", asset: "USDT",
      productType: "flexible", productTypeStatus: "missing", productDataMode: mode,
      holdingDataMode: "api", source: { kind: "manual", label: "manual" },
      tiers: [{ id: "tier", min: 0, max: null, apr: 0 }],
    };
    db.sqlite.prepare(`INSERT INTO product_catalog
      (owner_id,product_id,canonical_product_id,identity_key,payload,status,first_seen_at,last_seen_at)
      VALUES ('a',?,?,?,?,?, '2026-10-01','2026-10-01')`).run(id, id, id, JSON.stringify(product), status);
    db.sqlite.prepare("INSERT INTO holdings VALUES ('a',?,100,'2026-10-01')").run(id);
    db.sqlite.prepare(`INSERT INTO product_overrides
      (user_id,product_id,purchase_date,product_kind_override,updated_at)
      VALUES ('a',?,'2026-10-01','fixed','2026-10-01')`).run(id);
    db.sqlite.prepare("INSERT INTO product_override_terms VALUES ('a',?,7,'2026-10-01')").run(id);
  };
  catalog("catalog-due");
  catalog("api-not-manual", "api");
  catalog("archived", "manual", "archived");
  assert.equal(await recordDueManualMaturities(db, "a"), true);
  assert.deepEqual(db.sqlite.prepare("SELECT product_id FROM product_change_events ORDER BY product_id").all().map((r) => r.product_id), ["catalog-due", "user-due"]);
  db.sqlite.prepare("UPDATE product_change_events SET read_at = '2026-10-20'").run();
  assert.equal(await recordDueManualMaturities(db, "a"), true);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM product_change_events WHERE read_at IS NOT NULL").get().n, 2);
  db.sqlite.close();
});
