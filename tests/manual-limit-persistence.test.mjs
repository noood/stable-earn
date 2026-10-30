import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

const savedAt = "2026-10-29T00:00:00.000Z";
const migration = readFileSync(new URL("../drizzle/0023_manual_limit_mode.sql", import.meta.url), "utf8");

function product(id = "manual-limit-product", accountId = "okx-global", unlimited = false) {
  return {
    id, accountId, exchange: accountId === "bitget-wallet-morph" ? "bitget-wallet" : "okx",
    region: accountId === "bitget-wallet-morph" ? "morph" : "global", asset: "USDC",
    identityKey: `manual:${id}`, name: "Synthetic product", productType: "flexible", productTypeStatus: "known",
    productDataMode: "manual", holdingDataMode: "api", source: { kind: "manual", label: "人工维护" },
    tiers: [{ id: `${id}-tier-0`, min: 0, max: null, apr: 0, ...(unlimited ? { maxStatus: "unlimited" } : {}) }],
    rateCoverage: "unavailable", aprStatus: "unavailable", capacityStatus: unlimited ? "available" : "unavailable",
    tierStructureStatus: "complete",
  };
}

function insertCatalog(db, owner, entry, status = "active") {
  db.sqlite.prepare(`INSERT INTO product_catalog
    (owner_id,product_id,canonical_product_id,identity_key,payload,status,first_seen_at,last_seen_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(owner, entry.id, entry.identityKey, entry.identityKey, JSON.stringify(entry), status, savedAt, savedAt);
}

function fixture() {
  const db = sqliteDb();
  const entry = product();
  let owner = "alice";
  for (const userId of ["alice", "bob"]) {
    insertCatalog(db, userId, entry);
    db.sqlite.prepare("INSERT INTO holdings VALUES (?,?,100,?)").run(userId, entry.id, savedAt);
    db.sqlite.prepare(`INSERT INTO sync_snapshots (owner_id,cache_key,payload,updated_at)
      VALUES (?,'private-products',?,?)`).run(userId, JSON.stringify({
      holdingUpdates: { [entry.id]: 100 }, holdingSyncStates: { [entry.id]: "synced" }, holdingFallbacks: {},
    }), savedAt);
  }
  const load = moduleLoader({
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/db": { getDatabase: async () => db, getUserId: async () => owner },
    "@/lib/local-preview": { isLocalPreviewRequest: () => false },
    "@/lib/sync-diagnostics": { syncDiagnostic() {} },
  });
  const route = load("@/app/private/api/holdings/route");
  return {
    db, load, route, product: entry,
    user(value) { owner = value; },
    save(override, payload = {}) {
      return route.PUT(new Request("https://test/private/api/holdings", {
        method: "PUT", headers: { origin: "https://test", "content-type": "application/json" },
        body: JSON.stringify({ holdings: {}, changedHoldingProductIds: [], changedOverrideProductIds: [entry.id],
          overrides: { [entry.id]: { apr: 6.72, ...override } }, ...payload }),
      }));
    },
    async read() { return (await route.GET(new Request("https://test/private/api/holdings"))).json(); },
    limit(userId = owner) { return db.sqlite.prepare("SELECT first_tier_limit, first_tier_unlimited FROM product_override_limits WHERE user_id=? AND product_id=?").get(userId, entry.id); },
    apr(userId = owner) { return db.sqlite.prepare("SELECT confirmed_apr FROM product_overrides WHERE user_id=? AND product_id=?").get(userId, entry.id)?.confirmed_apr; },
    close() { db.sqlite.close(); },
  };
}

test("explicit manual limit modes round-trip through PUT, GET and the private snapshot", async () => {
  const f = fixture();
  try {
    for (const [override, expected] of [
      [{ firstTierLimit: null, firstTierUnlimited: true }, { first_tier_limit: null, first_tier_unlimited: 1 }],
      [{ firstTierLimit: 250, firstTierUnlimited: false }, { first_tier_limit: 250, first_tier_unlimited: 0 }],
      [{ firstTierLimit: null, firstTierUnlimited: false }, { first_tier_limit: null, first_tier_unlimited: 0 }],
    ]) {
      assert.equal((await f.save(override)).status, 200);
      assert.deepEqual({ ...f.limit() }, expected);
      const read = await f.read();
      assert.equal(read.overrides[f.product.id].firstTierLimit, override.firstTierLimit);
      assert.equal(read.overrides[f.product.id].firstTierUnlimited, override.firstTierUnlimited);
      assert.equal(read.holdings[f.product.id], 100);
      const snapshot = await f.load("@/lib/private-holdings-snapshot").loadPrivateHoldingsSnapshot(f.db, "alice");
      assert.equal(snapshot.overrideRows[0].first_tier_unlimited, expected.first_tier_unlimited);
      assert.equal(f.apr(), 6.72);
    }
  } finally { f.close(); }
});

test("legacy NULL state is omitted from GET; a legacy numeric limit becomes explicit limited", async () => {
  const f = fixture();
  try {
    assert.equal((await f.save({ firstTierLimit: null })).status, 200);
    assert.equal(f.limit().first_tier_unlimited, null);
    assert.equal(Object.hasOwn((await f.read()).overrides[f.product.id], "firstTierUnlimited"), false);
    assert.equal((await f.save({ firstTierLimit: 250 })).status, 200);
    assert.equal(f.limit().first_tier_unlimited, 0);
    assert.equal((await f.save({ firstTierLimit: null })).status, 200);
    assert.equal(f.limit().first_tier_unlimited, 0);
    assert.equal((await f.read()).overrides[f.product.id].firstTierUnlimited, false);
  } finally { f.close(); }
});

test("a legacy APR save preserves unlimited; a stale numeric limit conflicts without any partial writes", async () => {
  const f = fixture();
  try {
    await f.save({ firstTierLimit: null, firstTierUnlimited: true });
    assert.equal((await f.save({ apr: 7.5, firstTierLimit: null })).status, 200);
    assert.equal(f.limit().first_tier_unlimited, 1);
    assert.equal(f.apr(), 7.5);
    const eventsBefore = f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM product_change_events").get().n;
    const rejected = await f.save({ apr: 99, firstTierLimit: 50 }, {
      holdings: { [f.product.id]: 100 }, changedHoldingProductIds: [f.product.id],
    });
    assert.equal(rejected.status, 409);
    assert.equal(f.apr(), 7.5);
    assert.equal(f.limit().first_tier_limit, null);
    assert.equal(f.limit().first_tier_unlimited, 1);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM product_change_events").get().n, eventsBefore);
    assert.equal((await f.save({ firstTierLimit: null, firstTierUnlimited: false })).status, 200);
    assert.equal(f.limit().first_tier_unlimited, 0);
  } finally { f.close(); }
});

for (const existingLimit of [false, true]) test(`a concurrent unlimited save revokes a legacy write atomically; previous quota row ${existingLimit}`, async () => {
  const f = fixture();
  try {
    if (existingLimit) await f.save({ firstTierLimit: null, firstTierUnlimited: false });
    const eventsBefore = f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM product_change_events").get().n;
    const originalBatch = f.db.batch.bind(f.db);
    const concurrentAt = "2026-10-29T01:00:00.000Z";
    let injected = false;
    f.db.batch = async (statements) => {
      if (!injected) {
        injected = true;
        // A second client's committed save lands after PUT's reads but before
        // its write transaction, including a legitimate history event.
        f.db.sqlite.prepare(`INSERT INTO product_overrides (user_id,product_id,confirmed_apr,updated_at)
          VALUES ('alice',?,8,?) ON CONFLICT DO UPDATE SET confirmed_apr=excluded.confirmed_apr,updated_at=excluded.updated_at`)
          .run(f.product.id, concurrentAt);
        f.db.sqlite.prepare(`INSERT INTO product_override_limits
          (user_id,product_id,first_tier_limit,first_tier_unlimited,updated_at)
          VALUES ('alice',?,NULL,1,?) ON CONFLICT DO UPDATE SET first_tier_limit=NULL,first_tier_unlimited=1,updated_at=excluded.updated_at`)
          .run(f.product.id, concurrentAt);
        f.db.sqlite.prepare(`INSERT INTO product_change_events
          (owner_id,event_id,product_id,change_type,title,observed_at,source)
          VALUES ('alice','concurrent-choice',?,'capacity','首档额度修改',?,'手动编辑')`).run(f.product.id, concurrentAt);
      }
      return originalBatch(statements);
    };
    const response = await f.save({ apr: 99, firstTierLimit: null }, {
      holdings: { [f.product.id]: 100 }, changedHoldingProductIds: [f.product.id],
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /额度设置已更新/);
    assert.equal(f.limit().first_tier_limit, null);
    assert.equal(f.limit().first_tier_unlimited, 1);
    assert.equal(f.apr(), 8);
    assert.equal(f.db.sqlite.prepare("SELECT updated_at FROM holdings WHERE user_id='alice'").get().updated_at, savedAt);
    assert.equal(f.db.sqlite.prepare("SELECT updated_at FROM product_override_limits WHERE user_id='alice'").get().updated_at, concurrentAt);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM product_change_events").get().n, eventsBefore + 1);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM product_change_events WHERE event_id='concurrent-choice'").get().n, 1);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM product_override_terms WHERE user_id='alice'").get().n, existingLimit ? 1 : 0);
  } finally { f.close(); }
});

test("an unrelated database failure is not reported as a quota conflict", async () => {
  const f = fixture();
  try {
    await f.save({ firstTierLimit: 250, firstTierUnlimited: false });
    const failure = Error("synthetic database unavailable");
    f.db.batch = async () => { throw failure; };
    await assert.rejects(f.save({ apr: 99, firstTierLimit: 250 }), (error) => error === failure);
    assert.equal(f.apr(), 6.72);
    assert.equal(f.limit().first_tier_limit, 250);
  } finally { f.close(); }
});

test("explicit unlimited validation and SQLite constraints reject conflicting or malformed states", async () => {
  const f = fixture();
  try {
    await f.save({ firstTierLimit: 250, firstTierUnlimited: false });
    for (const invalid of [
      { firstTierLimit: 250, firstTierUnlimited: true },
      { firstTierLimit: 0, firstTierUnlimited: false },
      { firstTierLimit: null, firstTierUnlimited: "true" },
      { firstTierLimit: null, firstTierUnlimited: 1 },
      { firstTierLimit: null, firstTierUnlimited: null },
    ]) {
      assert.equal((await f.save(invalid)).status, 400);
      assert.equal(f.limit().first_tier_limit, 250);
      assert.equal(f.limit().first_tier_unlimited, 0);
    }
    for (const [amount, unlimited] of [[250, 1], [null, 2], [0, 0]]) {
      assert.throws(() => f.db.sqlite.prepare("UPDATE product_override_limits SET first_tier_limit=?,first_tier_unlimited=? WHERE user_id='alice'")
        .run(amount, unlimited), /CHECK constraint failed/);
    }
  } finally { f.close(); }
});

test("manual quota modes remain user-isolated and cannot alter trusted API holdings", async () => {
  const f = fixture();
  try {
    await f.save({ firstTierLimit: null, firstTierUnlimited: true }, { userId: "bob" });
    assert.equal(f.limit("bob"), undefined);
    f.user("bob");
    await f.save({ firstTierLimit: 500, firstTierUnlimited: false });
    assert.equal(f.limit("alice").first_tier_unlimited, 1);
    assert.equal(f.limit("bob").first_tier_limit, 500);
    const rejected = await f.save({ firstTierLimit: null, firstTierUnlimited: true }, {
      holdings: { [f.product.id]: 999 }, changedHoldingProductIds: [f.product.id],
    });
    assert.equal(rejected.status, 400);
    assert.equal(f.limit("bob").first_tier_limit, 500);
    assert.equal(f.db.sqlite.prepare("SELECT amount FROM holdings WHERE user_id='bob'").get().amount, 100);
  } finally { f.close(); }
});

test("the background maturity reader carries both explicit quota choices and legacy inheritance", async () => {
  const f = fixture();
  try {
    const observed = [];
    const load = moduleLoader({
      "@/lib/product-overrides": { applyProductOverride: (entry, override) => { observed.push(override); return entry; } },
      "@/lib/product-change-events": { buildManualMaturityEvents: () => [] },
      "./payload": {},
    });
    const service = load("@/lib/private-sync/service");
    for (const choice of [true, false, undefined]) {
      f.db.sqlite.prepare(`INSERT INTO product_overrides (user_id,product_id,confirmed_apr,updated_at)
        VALUES ('alice',?,6.72,?) ON CONFLICT DO NOTHING`).run(f.product.id, savedAt);
      f.db.sqlite.prepare(`INSERT INTO product_override_limits (user_id,product_id,first_tier_limit,first_tier_unlimited,updated_at)
        VALUES ('alice',?,NULL,?,?) ON CONFLICT DO UPDATE SET first_tier_unlimited=excluded.first_tier_unlimited`)
        .run(f.product.id, choice === undefined ? null : choice ? 1 : 0, savedAt);
      assert.equal(await service.recordDueManualMaturities(f.db, "alice"), false);
      const override = observed.at(-1);
      assert.equal(override.firstTierUnlimited, choice);
      assert.equal(Object.hasOwn(override, "firstTierUnlimited"), choice !== undefined);
    }
  } finally { f.close(); }
});

test("0023 preserves only existing BGW unlimited evidence, including rows without an APR override", async () => {
  const f = fixture();
  try {
    // Recreate the pre-0023 table shape while keeping the real D1-compatible helper.
    f.db.sqlite.exec("ALTER TABLE product_override_limits DROP COLUMN first_tier_unlimited");
    const bgw = product("existing-bgw", "bitget-wallet-morph", true);
    for (const owner of ["new-override", "saved-apr", "finite", "archived"]) insertCatalog(f.db, owner, bgw, owner === "archived" ? "archived" : "active");
    insertCatalog(f.db, "other-platform", product("other", "okx-global", true));
    insertCatalog(f.db, "unknown-bgw", product("unknown", "bitget-wallet-morph", false));
    f.db.sqlite.prepare(`INSERT INTO product_overrides (user_id,product_id,confirmed_apr,updated_at)
      VALUES ('saved-apr',?,8,?)`).run(bgw.id, savedAt);
    f.db.sqlite.prepare(`INSERT INTO product_override_limits (user_id,product_id,first_tier_limit,updated_at)
      VALUES ('saved-apr',?,NULL,?),('finite',?,250,?)`).run(bgw.id, savedAt, bgw.id, savedAt);
    f.db.sqlite.prepare("INSERT INTO holdings VALUES ('new-override',?,123,?)").run(bgw.id, savedAt);
    f.db.sqlite.exec(migration);
    for (const owner of ["new-override", "saved-apr", "archived"]) {
      assert.equal(f.db.sqlite.prepare("SELECT first_tier_unlimited FROM product_override_limits WHERE user_id=? AND product_id=?")
        .get(owner, bgw.id).first_tier_unlimited, 1);
    }
    assert.equal(f.db.sqlite.prepare("SELECT first_tier_unlimited FROM product_override_limits WHERE user_id='finite'").get().first_tier_unlimited, null);
    assert.equal(f.db.sqlite.prepare("SELECT first_tier_limit FROM product_override_limits WHERE user_id='finite'").get().first_tier_limit, 250);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM product_override_limits WHERE user_id IN ('other-platform','unknown-bgw')").get().n, 0);
    assert.equal(f.db.sqlite.prepare("SELECT confirmed_apr FROM product_overrides WHERE user_id='saved-apr'").get().confirmed_apr, 8);
    assert.equal(f.db.sqlite.prepare("SELECT updated_at FROM product_overrides WHERE user_id='saved-apr'").get().updated_at, savedAt);
    f.user("new-override");
    const read = await f.read();
    assert.equal(read.overrides[bgw.id].firstTierUnlimited, true);
    assert.equal(read.overrides[bgw.id].apr, null);
    assert.equal(read.holdings[bgw.id], 123);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM product_change_events").get().n, 0);
    assert.throws(() => f.db.sqlite.exec(migration), /duplicate column name/);
  } finally { f.close(); }
});

test("the migration backfill never replaces an explicit choice or an existing finite limit", () => {
  const f = fixture();
  try {
    const bgw = product("existing-bgw", "bitget-wallet-morph", true);
    for (const [owner, amount, unlimited] of [["pending", null, 0], ["finite", 250, null], ["unlimited", null, 1]]) {
      insertCatalog(f.db, owner, bgw);
      f.db.sqlite.prepare(`INSERT INTO product_override_limits
        (user_id,product_id,first_tier_limit,first_tier_unlimited,updated_at) VALUES (?,?,?,?,?)`).run(owner, bgw.id, amount, unlimited, savedAt);
    }
    // The DDL is a one-time operation; exercise the guarded DML independently.
    f.db.sqlite.exec(migration.slice(migration.indexOf("WITH old_bgw_unlimited")));
    assert.equal(f.db.sqlite.prepare("SELECT first_tier_unlimited FROM product_override_limits WHERE user_id='pending'").get().first_tier_unlimited, 0);
    assert.equal(f.db.sqlite.prepare("SELECT first_tier_limit FROM product_override_limits WHERE user_id='finite'").get().first_tier_limit, 250);
    assert.equal(f.db.sqlite.prepare("SELECT first_tier_unlimited FROM product_override_limits WHERE user_id='unlimited'").get().first_tier_unlimited, 1);
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS n FROM product_overrides WHERE user_id IN ('pending','finite')").get().n, 0);
  } finally { f.close(); }
});
