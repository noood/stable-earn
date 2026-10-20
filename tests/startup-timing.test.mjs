import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

const { withStartupServerTiming } = moduleLoader()("@/lib/startup-timing");

test("server timing is omitted unless private startup diagnostics are enabled", async () => {
  const response = await withStartupServerTiming(
    new Request("https://app.example/private/api/holdings"),
    async () => new Response("ok", { headers: { "Cache-Control": "private" } }),
  );

  assert.equal(response.headers.get("server-timing"), null);
  assert.equal(response.headers.get("cache-control"), "private");
  assert.equal(await response.text(), "ok");
});

test("diagnostics timing preserves the response and exposes only a duration header", async () => {
  const response = await withStartupServerTiming(
    new Request("https://app.example/private/api/products?visit=1&diagnostics=1"),
    async () => new Response(JSON.stringify({ products: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "private" },
    }),
  );

  assert.match(response.headers.get("server-timing") ?? "", /^app;dur=\d+(?:\.\d+)?$/);
  assert.equal(response.headers.get("cache-control"), "private");
  assert.deepEqual(await response.json(), { products: [] });
});
