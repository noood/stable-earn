import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

function sourceFor(path) {
  return ts.createSourceFile(path, readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
}

function importsFor(source) {
  return source.statements.filter(ts.isImportDeclaration).map((node) => node.moduleSpecifier.text);
}

function nodesMatching(source, predicate) {
  const found = [];
  function visit(node) {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

test("products route owns only HTTP exports; scheduled work calls the sync service directly", () => {
  const route = sourceFor("app/private/api/products/route.ts");
  const exportedFunctions = route.statements.filter((node) => ts.isFunctionDeclaration(node)
    && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
  assert.deepEqual(exportedFunctions.map((node) => node.name.text), ["GET", "POST"]);
  assert.ok(importsFor(route).includes("@/lib/private-sync/service"));
  assert.ok(!importsFor(route).some((id) => id.includes("/integrations/") || id.endsWith("/private-sync/payload")));
  const scheduled = importsFor(sourceFor("lib/scheduled-sync.ts"));
  assert.ok(scheduled.includes("@/lib/private-sync/service"));
  assert.ok(!scheduled.some((id) => id.startsWith("@/app/")));
});

test("private sync modules do not reverse-import pages or routes, and internal types have no runtime imports", () => {
  for (const name of ["types", "status", "snapshots", "payload", "service"]) {
    const source = sourceFor(`lib/private-sync/${name}.ts`);
    assert.ok(!importsFor(source).some((id) => id.startsWith("@/app/") || id === "next/server" || id === "@/lib/db"), name);
  }
  const types = sourceFor("lib/private-sync/types.ts");
  assert.ok(types.statements.every((node) => ts.isTypeAliasDeclaration(node)
    || (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)));
});

test("reading and candidate-building layers cannot commit; the refresh service retains one guarded commit", () => {
  for (const name of ["snapshots", "payload"]) {
    const source = sourceFor(`lib/private-sync/${name}.ts`);
    const writes = nodesMatching(source, (node) => ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ["batch", "run", "exec"].includes(node.expression.name.text));
    assert.equal(writes.length, 0, name);
  }
  const service = sourceFor("lib/private-sync/service.ts");
  const attempt = service.statements.find((node) => ts.isFunctionDeclaration(node)
    && node.name.text === "refreshPrivateProductsAttempt");
  const batchCalls = nodesMatching(attempt, (node) => ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "batch");
  assert.equal(batchCalls.length, 1);
  const body = attempt.body.getText(service);
  assert.ok(body.indexOf("renewRefresh(") < body.indexOf("retryable && !acceptPartial"));
  assert.ok(body.indexOf("retryable && !acceptPartial") < body.indexOf("await db.batch("));
  assert.ok(body.indexOf("prepareRefreshCommitGuard(") > body.indexOf("await db.batch("));
  assert.ok(body.indexOf("progress.committed = true") > body.indexOf("prepareSyncCacheSave("));
});

test("platform reader starts all configured scopes before any result resolves", async () => {
  const calls = [];
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const read = (name, value) => async () => {
    calls.push(name);
    await pending;
    return value;
  };
  const flexible = {
    rates: [], holdings: {}, productApiStatus: "complete", positionApiStatus: "complete",
    productListsComplete: true, positionListsComplete: true,
  };
  const fixed = {
    rates: [], holdings: {}, positions: [], productApiStatus: "complete", positionApiStatus: "complete",
    productListComplete: true, positionListComplete: true,
  };
  const bitget = { rates: [], holdings: {}, sync: { products: true, holdings: true } };
  const load = moduleLoader({
    "@/lib/live-rates": { fetchPublicRateSnapshot: read("public", { rates: [], failures: [] }), summarizePublicFailures: (values) => values },
    "@/lib/integrations/binance": {
      fetchBinanceFlexibleSnapshot: async (_credentials, account) => read(`binance-flexible:${account}`, flexible)(),
      fetchBinanceLockedSnapshot: async (_credentials, account) => read(`binance-fixed:${account}`, fixed)(),
    },
    "@/lib/integrations/bybit": {
      bybitGlobalApiBases: [],
      fetchBybitFlexibleHoldings: read("bybit-flexible", { rates: [], holdings: {}, sync: { failedAssets: [], partialAssets: [], successfulAssets: [] } }),
      fetchBybitShortFixedSnapshots: read("bybit-fixed", { rates: [], holdings: {}, sync: { productStatus: "complete", holdingStatus: "complete" } }),
    },
    "@/lib/integrations/bitget": { fetchBitgetSavingsSnapshot: read("bitget-flexible", bitget), fetchBitgetFixedSnapshot: read("bitget-fixed", bitget) },
    "@/lib/integrations/okx": { fetchOkxSavingsHoldings: read("okx", { holdings: {}, invalidAssets: [], snapshotComplete: true }) },
  });
  const credentials = Object.fromEntries(["binance-global", "binance-bahrain", "bybit-global", "bitget-global", "okx-global"]
    .map((id) => [id, { apiKey: "test", apiSecret: "test", passphrase: "test" }]));
  const snapshot = load("@/lib/private-sync/snapshots").fetchPrivateSnapshots(credentials);
  try {
    assert.deepEqual([...calls].sort(), ["public", "binance-flexible:global", "binance-fixed:global", "binance-flexible:bahrain", "binance-fixed:bahrain", "bybit-flexible", "bybit-fixed", "bitget-flexible", "bitget-fixed", "okx"].sort());
  } finally {
    release();
  }
  const result = await snapshot;
  assert.equal(result.binanceGlobalResult.snapshot.apiStatuses.flexibleProducts, "complete");
  assert.equal(result.binanceBahrainResult.snapshot.apiStatuses.fixedHoldings, "complete");
  assert.equal(result.bitgetResult.snapshot.sync.products, true);
  assert.equal(result.bybitGlobalResult.snapshot.apiStatuses.every((status) => status === "complete"), true);
});

test("candidate builder prepares real catalogue statements without changing the database", async () => {
  const db = sqliteDb();
  const rate = {
    productId: "candidate", externalProductId: "candidate", identityKey: "binance-global:USDT:flexible:candidate",
    productType: "flexible", productDataMode: "api", apr: 8, tiers: [{ min: 0, max: null, maxStatus: "unlimited", apr: 8 }],
    rateCoverage: "complete", fetchedAt: "2026-10-10T00:00:00.000Z", sourceLabel: "API",
    catalog: { accountId: "binance-global", exchange: "binance", region: "global", asset: "USDT", holdingDataMode: "api", apiAccess: "authenticated" },
  };
  const inactive = { status: "not_configured", snapshot: null };
  const load = moduleLoader({
    "@/lib/credentials": { loadCredentials: async () => ({}) },
    "./snapshots": { fetchPrivateSnapshots: async () => ({
      publicSnapshot: { rates: [], failures: [] },
      binanceGlobalResult: { status: "synced", snapshot: { rates: [rate], holdings: { candidate: 20 }, positions: [], apiStatuses: {
        flexibleProducts: "complete", flexibleHoldings: "complete", fixedProducts: "complete", fixedHoldings: "complete",
      } } },
      binanceBahrainResult: inactive, bybitGlobalResult: inactive, bitgetResult: inactive, okxResult: inactive,
    }) },
    "@/lib/live-rates": { summarizePublicFailures: (values) => values },
    "@/lib/sync-diagnostics": { syncDiagnostic() {} },
  });
  try {
    const before = db.sqlite.prepare("SELECT total_changes() AS count").get().count;
    const result = await load("@/lib/private-sync/payload").buildPrivatePayload(db, "test-user", null);
    assert.equal(result.catalog.products.length, 1);
    assert.ok(result.catalog.statements.length > 0);
    assert.equal(result.payload.holdingUpdates[result.catalog.products[0].id], 20);
    assert.equal(db.sqlite.prepare("SELECT total_changes() AS count").get().count, before);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM product_catalog").get().count, 0);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM sync_snapshots").get().count, 0);
  } finally {
    db.sqlite.close();
  }
});
