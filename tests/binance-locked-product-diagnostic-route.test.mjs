import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

function routeWithMocks({ identity = { userId: "owner" }, credentials = {
  "binance-global": { apiKey: "global-key", apiSecret: "global-secret" },
  "binance-bahrain": { apiKey: "bahrain-key", apiSecret: "bahrain-secret" },
} } = {}) {
  const calls = { database: 0, credentials: [], probes: [] };
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
      getDatabase: async () => { calls.database += 1; return {}; },
      getUserIdentity: async () => identity,
    },
    "@/lib/credentials": {
      loadCredentials: async (...args) => { calls.credentials.push(args); return credentials; },
    },
    "@/lib/integrations/binance": {
      diagnoseBinanceLockedProducts: async (...args) => {
        calls.probes.push(args);
        return { account: args[1] === "global" ? "binance-global" : "binance-bahrain", status: "empty", rows: [] };
      },
    },
    "@/lib/exchange-fetch": {
      withCapabilityProbeRequestGuard: async (task) => ({
        result: await task(),
        requestsStarted: 2,
        requestLimit: 40,
        concurrencyLimit: 3,
        stopReason: null,
      }),
    },
    "@/lib/request-security": {
      isSameOriginMutation: (request) => request.headers.get("origin") === new URL(request.url).origin,
      privateResponseHeaders: { "Cache-Control": "private, no-store" },
    },
  });
  const route = load("@/app/private/api/diagnostics/binance-locked-products/route");
  return { post: route.POST, get: route.GET, calls };
}

test("Binance fixed-product diagnosis requires login and same-origin POST", async () => {
  const unauthenticated = routeWithMocks({ identity: null });
  const denied = await unauthenticated.post(new Request("https://app.example/private/api/diagnostics/binance-locked-products", {
    method: "POST",
    headers: { origin: "https://app.example" },
  }));
  assert.equal(denied.status, 401);
  assert.equal(unauthenticated.calls.credentials.length, 0);
  assert.equal(unauthenticated.calls.probes.length, 0);

  const crossOrigin = routeWithMocks();
  const blocked = await crossOrigin.post(new Request("https://app.example/private/api/diagnostics/binance-locked-products", {
    method: "POST",
    headers: { origin: "https://attacker.example" },
  }));
  assert.equal(blocked.status, 403);
  assert.equal(crossOrigin.calls.probes.length, 0);
});

test("direct signed-in GET checks only Binance fixed product lists for configured regions", async () => {
  const { get, calls } = routeWithMocks();
  const response = await get(new Request("https://app.example/private/api/diagnostics/binance-locked-products"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.scope, "Binance 定期产品 APR、额度和申购状态");
  assert.equal(body.dataChangesCommitted, false);
  assert.equal(body.includesHoldingAmounts, false);
  assert.equal(body.endpoint, "/sapi/v1/simple-earn/locked/list");
  assert.equal(body.requestsStarted, 2);
  assert.deepEqual(calls.probes.map((args) => args[1]), ["global", "bahrain"]);
  assert.equal(JSON.stringify(body).includes("global-secret"), false);
  assert.equal(JSON.stringify(body).includes("bahrain-secret"), false);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

test("direct GET rejects cross-site fetches", async () => {
  const { get, calls } = routeWithMocks();
  const response = await get(new Request("https://app.example/private/api/diagnostics/binance-locked-products", {
    headers: { "sec-fetch-site": "cross-site" },
  }));
  assert.equal(response.status, 403);
  assert.equal(calls.credentials.length, 0);
});
