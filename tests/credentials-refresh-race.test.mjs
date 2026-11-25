import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

async function fixture() {
  const db = sqliteDb();
  const product = moduleLoader()("@/lib/local-preview").localPrivateProductsPreview().products
    .find((item) => item.id === "bn-g-usdt");
  const now = new Date().toISOString();
  db.sqlite.prepare(`INSERT INTO product_catalog
    (owner_id, product_id, canonical_product_id, identity_key, payload, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`)
    .run("user", product.id, product.identityKey, product.identityKey, JSON.stringify(product), now, now);
  let resume;
  let signalStarted;
  const paused = new Promise((resolve) => { resume = resolve; });
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const rate = { productId: product.id, apr: 6, tiers: product.tiers, rateCoverage: "complete", fetchedAt: now };
  const load = moduleLoader({
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "cloudflare:workers": { env: { CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64") } },
    "@/lib/db": { getDatabase: async () => db, getUserIdentity: async () => ({ userId: "user" }), isScheduledSyncEnabled: () => false },
    "@/lib/local-preview": { isLocalPreviewRequest: () => false },
    "@/lib/live-rates": { fetchPublicRateSnapshot: async () => ({ rates: [], failures: [] }), summarizePublicFailures: (failures) => failures },
    "@/lib/integrations/binance": {
      fetchBinanceFlexibleSnapshot: async () => {
        signalStarted();
        await paused;
        return { rates: [rate], holdings: { [product.id]: 100 }, productApiStatus: "complete", positionApiStatus: "complete", productListsComplete: true, positionListsComplete: true };
      },
      fetchBinanceLockedSnapshot: async () => ({ rates: [], holdings: {}, productApiStatus: "complete", positionApiStatus: "complete", productListComplete: true, positionListComplete: true }),
    },
    "@/lib/integrations/bitget": {},
    "@/lib/integrations/bybit": {},
    "@/lib/integrations/okx": {},
  }, { console: { info() {}, warn() {} } });
  const { prepareSaveCredential } = load("@/lib/credentials");
  await (await prepareSaveCredential(db, "user", "binance-global", {
    apiKey: "placeholder", apiSecret: "placeholder",
  })).run();
  return {
    db, load, product, started, resume: () => resume(),
    credential: () => db.sqlite.prepare("SELECT ciphertext FROM exchange_credentials WHERE user_id = 'user'").get(),
    catalogStatus: () => db.sqlite.prepare("SELECT status FROM product_catalog WHERE product_id = ?").get(product.id).status,
    snapshot: () => db.sqlite.prepare("SELECT payload FROM sync_snapshots WHERE owner_id = 'user'").get(),
  };
}

test("removing credentials while an exchange request is pending cannot restore its catalog or cache", async () => {
  const f = await fixture();
  const control = f.load("@/lib/refresh-control");
  const token = await control.acquireRefresh(f.db, "user");
  const refresh = f.load("@/lib/private-sync/service").refreshPrivateProductsCache(f.db, "user", { leaseToken: token });
  await f.started;
  const removed = await f.load("@/app/private/api/credentials/route").DELETE(new Request(
    "https://test/private/api/credentials?accountId=binance-global", { method: "DELETE", headers: { origin: "https://test" } },
  ));
  assert.equal(removed.status, 200);
  assert.equal(f.credential(), undefined);
  assert.equal(f.catalogStatus(), "archived");
  f.resume();
  await assert.rejects(refresh, /refresh lease expired/);
  assert.equal(f.catalogStatus(), "archived");
  assert.equal(f.snapshot(), undefined);
});

test("replacing credentials while an old exchange request is pending leaves no old snapshot", async () => {
  const f = await fixture();
  const control = f.load("@/lib/refresh-control");
  const token = await control.acquireRefresh(f.db, "user");
  const refresh = f.load("@/lib/private-sync/service").refreshPrivateProductsCache(f.db, "user", { leaseToken: token });
  await f.started;
  const saved = await f.load("@/app/private/api/credentials/route").PUT(new Request(
    "https://test/private/api/credentials", {
      method: "PUT",
      headers: { origin: "https://test", "content-type": "application/json" },
      body: JSON.stringify({ accountId: "binance-global", apiKey: "new-placeholder", apiSecret: "new-placeholder" }),
    },
  ));
  assert.equal(saved.status, 200);
  f.resume();
  await assert.rejects(refresh, /refresh lease expired/);
  assert.equal(f.snapshot(), undefined);
});

test("the sync batch itself rejects a revoked lease after the early renewal", async () => {
  const db = sqliteDb();
  const control = moduleLoader()("@/lib/refresh-control");
  const token = await control.acquireRefresh(db, "user");
  assert.equal(await control.renewRefresh(db, "user", token), true);
  const configurationToken = await control.supersedeRefreshForCredentialChange(db, "user");
  assert.ok(configurationToken);
  await assert.rejects(db.batch([
    control.prepareRefreshCommitGuard(db, "user", token),
    db.prepare("INSERT INTO holdings (user_id, product_id, amount, updated_at) VALUES (?, ?, ?, ?)")
      .bind("user", "stale", 100, new Date().toISOString()),
  ]), /malformed JSON/);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM holdings").get().count, 0);
});

test("credential mutations roll back with the catalog and snapshot and reset the daily marker when retried", async () => {
  for (const method of ["PUT", "DELETE"]) {
    const f = await fixture();
    const credential = f.credential();
    const { db, load } = f;
    const { refreshDay, dailyRefreshCompleted, refreshIsLocked } = load("@/lib/refresh-control");
    db.sqlite.prepare("INSERT INTO refresh_control (user_id, lease_token, lease_until, daily_day) VALUES ('user', 'old', 0, ?)").run(refreshDay());
    db.sqlite.exec(`INSERT INTO sync_snapshots (owner_id, cache_key, payload) VALUES ('user', 'private-products', '{}');
      CREATE TRIGGER fail_cache_delete BEFORE DELETE ON sync_snapshots
      BEGIN SELECT RAISE(ABORT, 'test cache delete failure'); END;`);
    const route = load("@/app/private/api/credentials/route");
    const request = () => new Request("https://test/private/api/credentials?accountId=binance-global", {
      method,
      headers: { origin: "https://test", "content-type": "application/json" },
      ...(method === "PUT" ? { body: JSON.stringify({ accountId: "binance-global", apiKey: "new-key", apiSecret: "new-secret" }) } : {}),
    });

    await assert.rejects(route[method](request()), /test cache delete failure/);
    assert.deepEqual(f.credential(), credential);
    assert.equal(f.catalogStatus(), "active");
    assert.equal(f.snapshot().payload, "{}");
    assert.equal(await dailyRefreshCompleted(db, "user"), true);
    assert.equal(await refreshIsLocked(db, "user"), false);

    db.sqlite.exec("DROP TRIGGER fail_cache_delete");
    assert.equal((await route[method](request())).status, 200);
    assert.notDeepEqual(f.credential(), credential);
    assert.equal(f.catalogStatus(), method === "DELETE" ? "archived" : "active");
    assert.equal(f.snapshot(), undefined);
    assert.equal(await dailyRefreshCompleted(db, "user"), false);
  }
});
