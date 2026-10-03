import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

function routeWithMocks({ identity = { userId: "owner" }, credentials = { "bitget-global": { apiKey: "secret-key", apiSecret: "secret", passphrase: "pass" } }, report = { dataChangesCommitted: false, includesHoldingAmounts: false, checkedScopeCount: 64, scopes: [] } } = {}) {
  const calls = { database: 0, credentials: [], probe: [] };
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
      getDatabase: async () => { calls.database += 1; return { readonly: true }; },
      getUserIdentity: async () => identity,
    },
    "@/lib/credentials": {
      loadCredentials: async (...args) => { calls.credentials.push(args); return credentials; },
    },
    "@/lib/platform-capability-probe": {
      probePlatformCapabilities: async (...args) => { calls.probe.push(args); return report; },
    },
    "@/lib/request-security": {
      isSameOriginMutation: (request) => request.headers.get("origin") === new URL(request.url).origin,
      privateResponseHeaders: { "Cache-Control": "private, no-store" },
    },
  });
  return { post: load("@/app/private/api/diagnostics/platform-capabilities/route").POST, calls };
}

function request(origin = "https://app.example") {
  return new Request("https://app.example/private/api/diagnostics/platform-capabilities", {
    method: "POST",
    headers: { origin },
  });
}

test("capability diagnostics require login and same-origin before loading credentials", async () => {
  const unauthenticated = routeWithMocks({ identity: null });
  assert.equal((await unauthenticated.post(request())).status, 401);
  assert.equal(unauthenticated.calls.credentials.length, 0);

  const crossOrigin = routeWithMocks();
  assert.equal((await crossOrigin.post(request("https://other.example"))).status, 403);
  assert.equal(crossOrigin.calls.credentials.length, 0);
  assert.equal(crossOrigin.calls.probe.length, 0);
});

test("capability diagnostics return only the probe report, scoped to the authenticated user", async () => {
  const report = { dataChangesCommitted: false, includesHoldingAmounts: false, checkedScopeCount: 64, scopes: [], apiKey: "must-not-appear" };
  const { post, calls } = routeWithMocks({ report });
  const response = await post(request());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(calls.credentials[0].slice(1), ["owner"]);
  assert.equal(calls.probe[0][0]["bitget-global"].apiKey, "secret-key");
  assert.equal(JSON.stringify(body).includes("secret-key"), false);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(body.checkedScopeCount, 64);
});
