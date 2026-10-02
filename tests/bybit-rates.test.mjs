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
      readExchangeJson: async () => ({
        retCode: 0,
        result: {
          list: [{
            productId: "2",
            coin: "USDC",
            status: "Available",
            estimateApr: "2.44%",
            tierAprDetails: [
              { min: "0", max: "200", estimateApr: "5.44%" },
              { min: "200", max: "-1", estimateApr: "2.44%" },
            ],
          }],
        },
      }),
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { fetchPublicRateSnapshot } = load("@/lib/live-rates");
  const result = await fetchPublicRateSnapshot();
  const rate = result.rates.find((item) => item.productId === "by-g-usdc");

  assert.equal(result.failures.length, 0);
  assert.ok(rate);
  assert.equal(rate.apr, 5.44);
  assert.deepEqual(rate.tiers, [
    { min: 0, max: 200, apr: 5.44 },
    { min: 200, max: null, apr: 2.44 },
  ]);
});
