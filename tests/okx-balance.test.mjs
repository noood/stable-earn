import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { moduleLoader } from "./helpers/load-ts.mjs";

test("OKX does not turn missing or malformed balances into zero holdings", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({ ok: true, status: 200, headers: new Headers(), url }),
      readExchangeJson: async () => ({ code: "0", data: [
        { ccy: "USDT", amt: "1000abc" },
        { ccy: "USDC", amt: "12.5" },
        { ccy: "BTC" },
      ] }),
    },
  }, { crypto: webcrypto });
  const { fetchOkxSavingsHoldings } = load("@/lib/integrations/okx");
  const result = await fetchOkxSavingsHoldings({ apiKey: "key", apiSecret: "secret", passphrase: "pass" });

  assert.deepEqual(result.holdings, { "okx-usdc": 12.5 });
  assert.deepEqual(result.observedAssets, ["USDT", "USDC", "BTC"]);
  assert.deepEqual(result.invalidAssets, ["USDT", "BTC"]);
});

test("an empty OKX balance response does not fabricate zero updates for every asset", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({ ok: true, status: 200, headers: new Headers(), url }),
      readExchangeJson: async () => ({ code: "0", data: [] }),
    },
  }, { crypto: webcrypto });
  const { fetchOkxSavingsHoldings } = load("@/lib/integrations/okx");

  const result = await fetchOkxSavingsHoldings({ apiKey: "key", apiSecret: "secret", passphrase: "pass" });
  assert.deepEqual(result.holdings, {});
  assert.deepEqual(result.observedAssets, []);
  assert.deepEqual(result.invalidAssets, []);
});
