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
  assert.equal(result.snapshotComplete, false);
});

test("a complete empty OKX response is authoritative for tracked coin balances", async () => {
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
  assert.equal(result.snapshotComplete, true);
});

test("a missing OKX data array is not treated as an authoritative empty response", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({ ok: true, status: 200, headers: new Headers(), url }),
      readExchangeJson: async () => ({ code: "0" }),
    },
  }, { crypto: webcrypto });
  const { fetchOkxSavingsHoldings } = load("@/lib/integrations/okx");

  await assert.rejects(
    fetchOkxSavingsHoldings({ apiKey: "key", apiSecret: "secret", passphrase: "pass" }),
    /data is not a list/,
  );
});

test("unreadable currency rows and duplicate tracked rows prevent zero inference", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({ ok: true, status: 200, headers: new Headers(), url }),
      readExchangeJson: async () => ({ code: "0", data: [
        { ccy: "USDT", amt: "10" },
        { ccy: "USDT", amt: "20" },
        { amt: "30" },
      ] }),
    },
  }, { crypto: webcrypto });
  const { fetchOkxSavingsHoldings } = load("@/lib/integrations/okx");

  const result = await fetchOkxSavingsHoldings({ apiKey: "key", apiSecret: "secret", passphrase: "pass" });
  assert.deepEqual(result.holdings, {});
  assert.deepEqual(result.invalidAssets, []);
  assert.deepEqual(result.observedAssets, ["USDT"]);
  assert.equal(result.snapshotComplete, false);
});
