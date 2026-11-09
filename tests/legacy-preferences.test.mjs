import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

function route({ signedIn = true, sameOrigin = true } = {}) {
  return moduleLoader({
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/db": { getUserIdentity: async () => signedIn ? { userId: "user" } : null },
    "@/lib/request-security": { isSameOriginMutation: () => sameOrigin, privateResponseHeaders: { "Cache-Control": "no-store" } },
  })("@/app/private/api/preferences/route");
}

test("legacy settings report no cooldown and reject obsolete changes", async () => {
  const api = route();
  const request = new Request("http://test/private/api/preferences");
  const read = await api.GET(request);
  assert.deepEqual(await read.json(), { manualRefreshCooldownMinutes: 0 });
  const write = await api.PUT(request);
  assert.equal(write.status, 410);
  assert.match((await write.json()).error, /重新加载/);
});

test("legacy settings retain authentication and origin checks", async () => {
  const request = new Request("http://test/private/api/preferences");
  assert.equal((await route({ signedIn: false }).GET(request)).status, 401);
  assert.equal((await route({ signedIn: false }).PUT(request)).status, 401);
  assert.equal((await route({ sameOrigin: false }).PUT(request)).status, 403);
});
