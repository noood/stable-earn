import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

function fixture() {
  const db = sqliteDb();
  const product = moduleLoader()("@/lib/local-preview").localPrivateProductsPreview().products
    .find((item) => item.id === "bn-g-usdt");
  const now = new Date().toISOString();
  db.sqlite.prepare(`INSERT INTO product_catalog
    (owner_id, product_id, canonical_product_id, identity_key, payload, status, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`)
    .run("user", product.id, product.identityKey, product.identityKey, JSON.stringify(product), now, now);
  let configured = true;
  let resume;
  let signalStarted;
  const paused = new Promise((resolve) => { resume = resolve; });
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const rate = { productId: product.id, apr: 6, tiers: product.tiers, rateCoverage: "complete", fetchedAt: now };
  const load = moduleLoader({
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/db": { getDatabase: async () => db, getUserIdentity: async () => ({ userId: "user" }), isScheduledSyncEnabled: () => false },
    "@/lib/credentials": {
      loadCredentials: async () => configured ? { "binance-global": { apiKey: "placeholder", apiSecret: "placeholder" } } : {},
      credentialAccount: (id) => id === "binance-global" ? { id, requiresPassphrase: false } : null,
      deleteCredential: async () => { configured = false; },
      saveCredential: async () => { configured = true; },
    },
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
  return {
    db, load, product, started, resume: () => resume(),
    configured: () => configured,
    catalogStatus: () => db.sqlite.prepare("SELECT status FROM product_catalog WHERE product_id = ?").get(product.id).status,
    snapshot: () => db.sqlite.prepare("SELECT payload FROM sync_snapshots WHERE owner_id = 'user'").get(),
  };
}

test("removing credentials while an exchange request is pending cannot restore its catalog or cache", async () => {
  const f = fixture();
  const control = f.load("@/lib/refresh-control");
  const token = await control.acquireRefresh(f.db, "user");
  const refresh = f.load("@/lib/private-sync/service").refreshPrivateProductsCache(f.db, "user", { leaseToken: token });
  await f.started;
  const removed = await f.load("@/app/private/api/credentials/route").DELETE(new Request(
    "https://test/private/api/credentials?accountId=binance-global", { method: "DELETE", headers: { origin: "https://test" } },
  ));
  assert.equal(removed.status, 200);
  assert.equal(f.configured(), false);
  assert.equal(f.catalogStatus(), "archived");
  f.resume();
  await assert.rejects(refresh, /refresh lease expired/);
  assert.equal(f.catalogStatus(), "archived");
  assert.equal(f.snapshot(), undefined);
});

test("replacing credentials while an old exchange request is pending leaves no old snapshot", async () => {
  const f = fixture();
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
