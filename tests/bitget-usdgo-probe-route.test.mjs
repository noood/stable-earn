import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

function routeWithMocks({ identity = { userId: "owner" }, credential = { apiKey: "secret-key", apiSecret: "secret", passphrase: "pass" } } = {}) {
  const calls = { credential: [], probe: [] };
  const probe = {
    asset: "USDGO",
    productApi: { status: "empty", rowCount: 0, eligibleFlexibleCount: 0, rows: [] },
    holdingsApi: { status: "complete", complete: true, pageCount: 1, rowCount: 0, rows: [] },
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
      loadCredential: async (...args) => {
        calls.credential.push(args);
        return credential;
      },
    },
    "@/lib/integrations/bitget": {
      probeBitgetAsset: async (...args) => {
        calls.probe.push(args);
        return probe;
      },
    },
    "@/lib/request-security": {
      isSameOriginMutation: (request) => request.headers.get("origin") === new URL(request.url).origin,
      privateResponseHeaders: { "Cache-Control": "private, no-store" },
    },
    "@/lib/sync-diagnostics": {
      withSyncDiagnostics: async (_user, _options, task) => task(),
      withSyncPlatform: async (_platform, task) => task(),
      syncDiagnostic: () => {},
    },
  });
  return { post: load("@/app/private/api/diagnostics/bitget-usdgo/route").POST, calls, probe };
}

function request(origin = "https://app.example") {
  return new Request("https://app.example/private/api/diagnostics/bitget-usdgo", {
    method: "POST",
    headers: { origin },
  });
}

test("USDGO probe is authenticated, same-origin, and returns no persisted data", async () => {
  const { post, calls } = routeWithMocks();
  const response = await post(request());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.persisted, false);
  assert.equal(body.probe.asset, "USDGO");
  assert.deepEqual(calls.credential[0].slice(1), ["owner", "bitget-global"]);
  assert.equal(calls.probe[0][0].apiKey, "secret-key");
  assert.equal(calls.probe[0][1], "USDGO");
  assert.equal(JSON.stringify(body).includes("secret-key"), false);
});

test("USDGO probe rejects unauthenticated and cross-origin requests before reading credentials", async () => {
  const unauthenticated = routeWithMocks({ identity: null });
  const unauthorizedResponse = await unauthenticated.post(request());
  assert.equal(unauthorizedResponse.status, 401);
  assert.equal(unauthenticated.calls.credential.length, 0);
  assert.equal(unauthenticated.calls.probe.length, 0);

  const crossOrigin = routeWithMocks();
  const forbiddenResponse = await crossOrigin.post(request("https://other.example"));
  assert.equal(forbiddenResponse.status, 403);
  assert.equal(crossOrigin.calls.credential.length, 0);
  assert.equal(crossOrigin.calls.probe.length, 0);
});

test("USDGO probe requires an existing complete Bitget credential", async () => {
  const { post, calls } = routeWithMocks({ credential: null });
  const response = await post(request());
  assert.equal(response.status, 409);
  assert.equal(calls.probe.length, 0);
});
