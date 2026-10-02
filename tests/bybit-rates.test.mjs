import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

test("Bybit public flexible APR keeps the complete tier ladder", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        url,
      }),
      readExchangeJson: async (response) => {
        const coin = new URL(response.url).searchParams.get("coin");
        return {
          retCode: 0,
          result: {
            list: [{
              productId: coin === "USDC" ? "2" : "1",
              coin,
              status: "Available",
              estimateApr: coin === "USDC" ? "2.44%" : "2.1%",
              tierAprDetails: coin === "USDC"
                ? [
                  { min: "0", max: "200", estimateApr: "5.44%" },
                  { min: "200", max: "-1", estimateApr: "2.44%" },
                ]
                : [{ min: "0", max: "-1", estimateApr: "2.1%" }],
            }],
          },
        };
      },
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { fetchPublicRateSnapshot } = load("@/lib/live-rates");
  const result = await fetchPublicRateSnapshot();
  const rate = result.rates.find((item) => item.identityKey === "bybit-global:USDC:flexible:2");

  assert.equal(result.failures.length, 0);
  assert.ok(result.rates.find((item) => item.identityKey === "bybit-global:USDT:flexible:1"));
  assert.ok(rate);
  assert.equal(rate.apr, 5.44);
  assert.deepEqual(rate.tiers, [
    { min: 0, max: 200, apr: 5.44 },
    { min: 200, max: null, apr: 2.44 },
  ]);
  assert.equal(rate.capacitySource, "live");
  assert.ok(rate.capacityFetchedAt);
});
