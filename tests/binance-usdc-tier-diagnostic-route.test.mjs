import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

function routeWithMocks({ identity = { userId: "owner" }, credentials = {
  "binance-global": { apiKey: "secret-key", apiSecret: "secret" },
  "binance-bahrain": { apiKey: "other-key", apiSecret: "other-secret" },
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
      diagnoseBinanceFlexibleTiers: async (...args) => {
        calls.probes.push(args);
        return { account: args[1] === "global" ? "binance-global" : "binance-bahrain", status: "empty", rows: [] };
      },
    },
    "@/lib/request-security": {
      isSameOriginMutation: (request) => request.headers.get("origin") === new URL(request.url).origin,
      privateResponseHeaders: { "Cache-Control": "private, no-store" },
    },
  });
  const route = load("@/app/private/api/diagnostics/binance-usdc-tiers/route");
  return { post: route.POST, get: route.GET, calls };
}

function request(origin = "https://app.example", asset) {
  const url = new URL("https://app.example/private/api/diagnostics/binance-usdc-tiers");
  if (asset) url.searchParams.set("asset", asset);
  return new Request(url, {
    method: "POST",
    headers: { origin },
  });
}

test("narrow Binance flexible diagnostic requires authentication and same-origin", async () => {
  const unauthenticated = routeWithMocks({ identity: null });
  assert.equal((await unauthenticated.post(request())).status, 401);
  assert.equal(unauthenticated.calls.credentials.length, 0);

  const crossOrigin = routeWithMocks();
  assert.equal((await crossOrigin.post(request("https://attacker.example"))).status, 403);
  assert.equal(crossOrigin.calls.credentials.length, 0);
  assert.equal(crossOrigin.calls.probes.length, 0);
});

test("direct diagnostic GET is available to the signed-in user but rejects cross-site fetches", async () => {
  const crossSite = routeWithMocks();
  const blocked = await crossSite.get(new Request("https://app.example/private/api/diagnostics/binance-usdc-tiers", {
    headers: { "sec-fetch-site": "cross-site" },
  }));
  assert.equal(blocked.status, 403);
  assert.equal(crossSite.calls.credentials.length, 0);

  const direct = routeWithMocks();
  const response = await direct.get(new Request("https://app.example/private/api/diagnostics/binance-usdc-tiers"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).scope, "Binance USDC 活期产品 APR");
});

test("narrow diagnostic can select USDT and BTC, and rejects other assets before reading credentials", async () => {
  for (const asset of ["USDT", "BTC"]) {
    const selected = routeWithMocks();
    const response = await selected.get(new Request(`https://app.example/private/api/diagnostics/binance-usdc-tiers?asset=${asset}`));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.scope, `Binance ${asset} 活期产品 APR`);
    assert.equal(selected.calls.probes.length, 2);
    assert.deepEqual(selected.calls.probes.map((call) => call[2]), [asset, asset]);
  }

  const unsupported = routeWithMocks();
  const rejected = await unsupported.get(new Request("https://app.example/private/api/diagnostics/binance-usdc-tiers?asset=ETH"));
  assert.equal(rejected.status, 400);
  assert.equal(unsupported.calls.credentials.length, 0);
  assert.equal(unsupported.calls.probes.length, 0);
});

test("narrow Binance flexible diagnostic makes at most one read-only request per configured account", async () => {
  const { post, calls } = routeWithMocks();
  const response = await post(request());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(calls.credentials[0].slice(1), ["owner"]);
  assert.equal(calls.probes.length, 2);
  assert.deepEqual(calls.probes.map((call) => [call[1], call[2]]), [["global", "USDC"], ["bahrain", "USDC"]]);
  assert.equal(body.dataChangesCommitted, false);
  assert.equal(body.includesHoldingAmounts, false);
  assert.equal(body.requestLimit, 2);
  assert.equal(body.requestsStarted, 2);
  assert.equal(JSON.stringify(body).includes("secret-key"), false);
  assert.equal(JSON.stringify(body).includes("secret"), false);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

test("narrow Binance USDC diagnostic marks unconfigured accounts without requesting them", async () => {
  const { post, calls } = routeWithMocks({ credentials: { "binance-global": { apiKey: "key", apiSecret: "secret" } } });
  const body = await (await post(request())).json();

  assert.equal(calls.probes.length, 1);
  assert.equal(body.requestsStarted, 1);
  assert.equal(body.results.find((result) => result.account === "binance-bahrain").status, "not_configured");
});
