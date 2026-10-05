import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

function routeWithMocks({ identity = { userId: "owner" }, credential = { apiKey: "secret-key", apiSecret: "secret", passphrase: "pass" } } = {}) {
  const calls = { credentials: [], probes: [], targetedProbes: [] };
  const probe = {
    scope: "Bitget Savings product APR and subscription capacity fields",
    dataChangesCommitted: false,
    includesHoldingAmounts: false,
    requestLimit: 8,
    requestsStarted: 6,
    products: [],
    subscriptionDetails: [],
  };
  const load = moduleLoader({
    "next/server": {
      NextResponse: {
        json: (body, init = {}) => new Response(JSON.stringify(body), {
          status: init.status ?? 200,
          headers: { "Content-Type": "application/json", ...init.headers },
        }),
      },
    },
    "@/lib/db": {
      getDatabase: async () => ({ readOnlyProbeDb: true }),
      getUserIdentity: async () => identity,
    },
    "@/lib/credentials": {
      loadCredential: async (...args) => { calls.credentials.push(args); return credential; },
    },
    "@/lib/integrations/bitget": {
      probeBitgetProductEvidence: async (...args) => {
        calls.probes.push(args);
        return probe;
      },
      probeBitgetProductCapacity: async (...args) => {
        calls.targetedProbes.push(args);
        return { ...probe, scope: "Single Bitget product remaining amount evidence" };
      },
    },
    "@/lib/request-security": {
      isSameOriginMutation: (request) => request.headers.get("origin") === new URL(request.url).origin,
      privateResponseHeaders: { "Cache-Control": "private, no-store" },
    },
  });
  return { post: load("@/app/private/api/diagnostics/bitget-products/route").POST,
    get: load("@/app/private/api/diagnostics/bitget-products/route").GET, calls, probe };
}

function request(method = "GET", origin = undefined, query = "") {
  return new Request(`https://app.example/private/api/diagnostics/bitget-products${query}`, {
    method,
    headers: origin ? { origin } : undefined,
  });
}

test("Bitget product diagnostic is authenticated, same-origin, and does not expose credentials", async () => {
  const unauthorized = routeWithMocks({ identity: null });
  assert.equal((await unauthorized.get(request())).status, 401);
  assert.equal(unauthorized.calls.credentials.length, 0);

  const crossOrigin = routeWithMocks();
  assert.equal((await crossOrigin.post(request("POST", "https://attacker.example"))).status, 403);
  assert.equal(crossOrigin.calls.credentials.length, 0);
  assert.equal(crossOrigin.calls.probes.length, 0);

  const valid = routeWithMocks();
  const response = await valid.get(request());
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(valid.calls.credentials[0].slice(1), ["owner", "bitget-global"]);
  assert.equal(valid.calls.probes[0][0].apiKey, "secret-key");
  assert.equal(body.includesHoldingAmounts, false);
  assert.equal(body.dataChangesCommitted, false);
  assert.equal(JSON.stringify(body).includes("secret-key"), false);
  assert.equal(JSON.stringify(body).includes("secret"), false);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

test("Bitget product diagnostic requires an existing complete read-only credential", async () => {
  const unconfigured = routeWithMocks({ credential: null });
  const response = await unconfigured.get(request());
  assert.equal(response.status, 409);
  assert.equal(unconfigured.calls.probes.length, 0);
});

test("single-product diagnostic validates and scopes the requested asset and product ID", async () => {
  const invalid = routeWithMocks();
  const invalidResponse = await invalid.get(request("GET", undefined, "?asset=USDC&productId=not-a-number"));
  assert.equal(invalidResponse.status, 400);
  assert.equal(invalid.calls.credentials.length, 0);

  const valid = routeWithMocks();
  const response = await valid.get(request("GET", undefined, "?asset=USDC&productId=984594834441801728"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(valid.calls.probes.length, 0);
  assert.equal(valid.calls.targetedProbes.length, 1);
  assert.deepEqual(valid.calls.targetedProbes[0].slice(1), ["USDC", "984594834441801728"]);
  assert.equal(body.scope, "Single Bitget product remaining amount evidence");
  assert.equal(body.dataChangesCommitted, false);
});

test("Bitget product evidence reads product and subscription endpoints only, then strips unrelated fields", async () => {
  const calls = [];
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url, init) => {
        const parsed = new URL(url);
        calls.push({ path: parsed.pathname, query: Object.fromEntries(parsed.searchParams.entries()), method: init?.method ?? "GET" });
        if (parsed.pathname.endsWith("/savings/product")) {
          const coin = parsed.searchParams.get("coin");
          const data = coin === "USDT" ? [
            { productId: "flex-ladder", coin, periodType: "flexible", period: "", apyType: "ladder", status: "in_progress", productLevel: "normal", holdAmount: "123", apyList: [{ rateLevel: "0", minStepVal: "0", maxStepVal: "200", currentApy: "6.00", orderId: "private" }] },
            { productId: "fixed-single", coin, periodType: "fixed", period: "7d", apyType: "single", status: "in_progress", productLevel: "normal", apyList: [{ rateLevel: "0", minStepVal: "0", maxStepVal: "-1", currentApy: "3.00" }] },
          ] : [];
          return new Response(JSON.stringify({ code: "00000", msg: "success", data }), { status: 200 });
        }
        return new Response(JSON.stringify({ code: "00000", msg: "success", data: {
          singleMinAmount: "10", singleMaxAmount: "2000", remainingAmount: "4899",
          apyList: [{ rateLevel: "0", minStepVal: "0", maxStepVal: "200", currentApy: "6.00" }],
          holdAmount: "123", orderId: "private", secret: "private",
        } }), { status: 200 });
      },
      readExchangeText: async (response) => response.text(),
      logExchangePayload: () => {},
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
    "@/lib/platform-capabilities": { apiAssetsFor: () => [] },
  });
  const { probeBitgetProductEvidence } = load("@/lib/integrations/bitget");
  const result = await probeBitgetProductEvidence({ apiKey: "key", apiSecret: "secret", passphrase: "pass" });

  assert.equal(result.requestsStarted, 6);
  assert.equal(result.requestLimit, 8);
  assert.deepEqual(result.products.map((entry) => entry.asset), ["USDT", "USDC", "BTC", "USDGO"]);
  assert.equal(result.products[0].rows[0].apyType, "ladder");
  assert.equal("holdAmount" in result.products[0].rows[0], false);
  assert.deepEqual(calls.map((call) => call.path), [
    "/api/v2/earn/savings/product", "/api/v2/earn/savings/product",
    "/api/v2/earn/savings/product", "/api/v2/earn/savings/product",
    "/api/v2/earn/savings/subscribe-info", "/api/v2/earn/savings/subscribe-info",
  ]);
  assert.equal(calls.every((call) => call.method === "GET"), true);
  assert.deepEqual(result.subscriptionDetails.map((entry) => entry.periodType), ["flexible", "fixed"]);
  assert.equal(result.subscriptionDetails[0].data.remainingAmount, "4899");
  assert.equal("holdAmount" in result.subscriptionDetails[0].data, false);
  assert.equal("secret" in result.subscriptionDetails[0].data, false);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("single-product capacity evidence verifies the product and reads only its subscription detail", async () => {
  const calls = [];
  const targetProductId = "984594834441801728";
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url, init) => {
        const parsed = new URL(url);
        calls.push({ path: parsed.pathname, query: Object.fromEntries(parsed.searchParams.entries()), method: init?.method ?? "GET" });
        const data = parsed.pathname.endsWith("/savings/product")
          ? [
            { productId: targetProductId, coin: "USDC", periodType: "flexible", apyType: "ladder", status: "in_progress", apyList: [{ minStepVal: "0", maxStepVal: "300", currentApy: "6.66" }, { minStepVal: "300", maxStepVal: "1000000", currentApy: "1.87" }], holdAmount: "private" },
            { productId: "other-product", coin: "USDC", periodType: "flexible", apyType: "single", apyList: [{ minStepVal: "0", maxStepVal: "10000000", currentApy: "8" }] },
          ]
          : { singleMinAmount: "0.1", singleMaxAmount: "1000000", remainingAmount: "999096.44", apyList: [{ minStepVal: "0", maxStepVal: "300", currentApy: "6.66" }, { minStepVal: "300", maxStepVal: "1000000", currentApy: "1.87" }], holdAmount: "private", secret: "private" };
        return new Response(JSON.stringify({ code: "00000", msg: "success", data }), { status: 200 });
      },
      readExchangeText: async (response) => response.text(),
      logExchangePayload: () => {},
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
    "@/lib/platform-capabilities": { apiAssetsFor: () => [] },
  });
  const { probeBitgetProductCapacity } = load("@/lib/integrations/bitget");
  const result = await probeBitgetProductCapacity(
    { apiKey: "key", apiSecret: "secret", passphrase: "pass" },
    "USDC",
    targetProductId,
  );

  assert.equal(result.status, "returned");
  assert.equal(result.requestsStarted, 2);
  assert.equal(result.includesHoldingAmounts, false);
  assert.equal(result.includesRemainingAmountField, true);
  assert.equal(result.subscriptionDetail.remainingAmount, "999096.44");
  assert.equal(result.product.apyType, "ladder");
  assert.equal("holdAmount" in result.product, false);
  assert.equal("holdAmount" in result.subscriptionDetail, false);
  assert.equal("secret" in result.subscriptionDetail, false);
  assert.deepEqual(calls, [
    { path: "/api/v2/earn/savings/product", query: { coin: "USDC", filter: "available_and_held" }, method: "GET" },
    { path: "/api/v2/earn/savings/subscribe-info", query: { productId: targetProductId, periodType: "flexible" }, method: "GET" },
  ]);
});
