import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";
import { sqliteDb } from "./helpers/sqlite-db.mjs";

function routeFixture(userId = "user-1") {
  const db = sqliteDb();
  const insert = db.sqlite.prepare(`INSERT INTO product_change_events
    (owner_id, event_id, product_id, change_type, title, observed_at, source, attention)
    VALUES (?, ?, 'product-a', 'rate', 'APR 调整', '2026-10-01T00:00:00.000Z', '定时刷新', 1)`);
  insert.run("user-1", "event-user-1");
  insert.run("user-2", "event-user-2");
  const load = moduleLoader({
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/db": { getDatabase: async () => db, getUserIdentity: async () => userId ? { userId } : null },
    "@/lib/request-security": {
      privateResponseHeaders: { "Cache-Control": "private, no-store" },
      isSameOriginMutation: (request) => request.headers.get("origin") === new URL(request.url).origin,
    },
  });
  return load("@/app/private/api/product-history/route");
}

test("product history endpoint requires login and only returns the caller's records", async () => {
  const authorized = routeFixture();
  const response = await authorized.GET(new Request("https://example.test/private/api/product-history?productId=product-a"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).events.map((event) => event.id), ["event-user-1"]);

  const unauthorized = routeFixture(null);
  assert.equal((await unauthorized.GET(new Request("https://example.test/private/api/product-history?productId=product-a"))).status, 401);
});

test("opening product history persists read state for the caller only", async () => {
  const authorized = routeFixture();
  const response = await authorized.POST(new Request("https://example.test/private/api/product-history", {
    method: "POST",
    headers: { origin: "https://example.test", "content-type": "application/json" },
    body: JSON.stringify({ productId: "product-a", eventIds: ["event-user-1"] }),
  }));
  assert.equal(response.status, 200);
  const listed = await authorized.GET(new Request("https://example.test/private/api/product-history?productId=product-a"));
  assert.equal((await listed.json()).events[0].readAt, (await response.json()).readAt);

  const crossOrigin = routeFixture();
  assert.equal((await crossOrigin.POST(new Request("https://example.test/private/api/product-history", {
    method: "POST",
    headers: { origin: "https://attacker.example", "content-type": "application/json" },
    body: JSON.stringify({ productId: "product-a", eventIds: ["event-user-1"] }),
  }))).status, 403);

  const unauthorized = routeFixture(null);
  assert.equal((await unauthorized.POST(new Request("https://example.test/private/api/product-history", {
    method: "POST",
    headers: { origin: "https://example.test", "content-type": "application/json" },
    body: JSON.stringify({ productId: "product-a", eventIds: ["event-user-1"] }),
  }))).status, 401);
});
