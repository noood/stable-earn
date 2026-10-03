import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

test("Binance flexible capability probe treats complete empty responses as empty only for the probe", async () => {
  const requests = [];
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => {
        const parsed = new URL(url);
        requests.push(parsed);
        return { ok: true, status: 200, headers: new Headers(), url };
      },
      readExchangeJson: async () => ({ total: 0, rows: [] }),
    },
    "@/lib/sync-diagnostics": { syncDiagnostic: () => {} },
  });
  const { fetchBinanceFlexibleSnapshot } = load("@/lib/integrations/binance");
  const credentials = { apiKey: "key", apiSecret: "secret" };

  const result = await fetchBinanceFlexibleSnapshot(credentials, "global", ["BTC"], true);

  assert.deepEqual(result.rates, []);
  assert.deepEqual(result.holdings, {});
  assert.equal(result.productListsComplete, true);
  assert.equal(result.positionListsComplete, true);
  assert.deepEqual(requests.map((url) => [url.pathname, url.searchParams.get("asset")]).sort(), [
    ["/sapi/v1/simple-earn/flexible/list", "BTC"],
    ["/sapi/v1/simple-earn/flexible/position", "BTC"],
  ].sort());
  await assert.rejects(
    fetchBinanceFlexibleSnapshot(credentials, "global", ["BTC"]),
    /returned no BTC flexible product/,
  );
});
