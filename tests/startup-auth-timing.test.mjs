import assert from "node:assert/strict";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { moduleLoader } from "./helpers/load-ts.mjs";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(publicKey), kid: "synthetic", alg: "RS256" };
const issuer = "https://access.example";
const token = await new SignJWT({ email: "synthetic@example.test" }).setProtectedHeader({ alg: "RS256", kid: "synthetic" })
  .setIssuer(issuer).setAudience("test-audience").setExpirationTime("1h").sign(privateKey);

function fixture(fetchKeys = async () => Response.json({ keys: [jwk] })) {
  const load = moduleLoader({
    "cloudflare:workers": { env: { TEAM_DOMAIN: issuer, POLICY_AUD: "test-audience" } },
    "@/lib/request-security": { isLocalDevelopmentRequest: () => false },
  }, { fetch: fetchKeys });
  const { withStartupServerTiming } = load("@/lib/startup-timing");
  const { getUserIdentity } = load("@/lib/db");
  return async (diagnostics = true, jwt = token) => {
    const request = new Request(`https://app.example/private/api/products${diagnostics ? "?diagnostics=1" : ""}`, { headers: { "cf-access-jwt-assertion": jwt } });
    return withStartupServerTiming(request, async (timing) => Response.json({ authenticated: Boolean(await timing.measure("auth", () => getUserIdentity(request))) }));
  };
}

test("real JWT verification distinguishes fetched and cached public keys without revealing the token", async () => {
  let fetches = 0;
  const read = fixture(async () => { fetches++; return Response.json({ keys: [jwk] }); });
  const first = await read();
  assert.deepEqual(await first.json(), { authenticated: true });
  assert.match(first.headers.get("server-timing"), /auth_keys_fetch;dur=/);
  assert.match(first.headers.get("server-timing"), /auth_keys_cached;desc="value=0"/);
  const second = await read();
  assert.match(second.headers.get("server-timing"), /auth_keys_cached;desc="value=1"/);
  assert.doesNotMatch(second.headers.get("server-timing"), /auth_keys_fetch;dur=/);
  assert.equal(fetches, 1);
  assert.doesNotMatch(first.headers.get("server-timing"), /synthetic|example|eyJ|RS256/);
  assert.equal((await read(false)).headers.get("server-timing"), null);
  assert.deepEqual(await (await read(true, token + "invalid")).json(), { authenticated: false });
});

test("concurrent auth diagnostics do not copy another request's network span", async () => {
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const read = fixture(async () => { entered(); await gate; return Response.json({ keys: [jwk] }); });
  const first = read();
  await started;
  const second = read();
  await new Promise(setImmediate);
  release();
  const [one, two] = await Promise.all([first, second]);
  assert.match(one.headers.get("server-timing"), /auth_keys_fetch;dur=/);
  assert.doesNotMatch(two.headers.get("server-timing"), /auth_keys_fetch;dur=/);
  assert.match(two.headers.get("server-timing"), /auth_keys_loading;desc="value=1"/);
  assert.deepEqual(await two.json(), { authenticated: true });
});

test("diagnostics keep issuer, audience, expiry and required identity validation unchanged", async () => {
  const read = fixture();
  for (const scenario of [
    { issuer: "https://wrong.example", audience: "test-audience", expiry: "1h", email: "synthetic@example.test" },
    { issuer, audience: "wrong-audience", expiry: "1h", email: "synthetic@example.test" },
    { issuer, audience: "test-audience", expiry: 0, email: "synthetic@example.test" },
    { issuer, audience: "test-audience", expiry: "1h", email: "" },
  ]) {
    const invalid = await new SignJWT({ email: scenario.email }).setProtectedHeader({ alg: "RS256", kid: "synthetic" })
      .setIssuer(scenario.issuer).setAudience(scenario.audience).setExpirationTime(scenario.expiry).sign(privateKey);
    assert.deepEqual(await (await read(true, invalid)).json(), { authenticated: false });
    assert.deepEqual(await (await read(false, invalid)).json(), { authenticated: false });
  }
});
