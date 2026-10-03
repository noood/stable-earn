import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { moduleLoader } from "./helpers/load-ts.mjs";

test("OKX On-chain offers are fetched once and safely grouped into the four monitored currencies", async () => {
  let requestedUrl;
  let requestInit;
  let fetchOptions;
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url, init, options) => {
        requestedUrl = url;
        requestInit = init;
        fetchOptions = options;
        return { ok: true, status: 200 };
      },
      readExchangeJson: async () => ({
        code: "0",
        data: [
          {
            ccy: "USDT", productId: "offer-123", protocol: "Example Staking", protocolType: "staking",
            state: "available", term: "0", apy: "4.25", investData: [{ ccy: "USDT", amt: "9000" }],
            earningData: [{ ccy: "USDT", amt: "42" }],
          },
          { ccy: "BTC", productId: "other-asset", protocol: "Other", apy: "3" },
          { ccy: "USDT", productId: "bad-rate", protocol: "Odd", apy: "<script>" },
          { ccy: "ETH", productId: "unmonitored-asset", protocol: "Other", apy: "2" },
        ],
      }),
    },
  }, { crypto: webcrypto });

  const { fetchOkxOnchainOffers } = load("@/lib/integrations/okx");
  const result = await fetchOkxOnchainOffers({ apiKey: "test-key", apiSecret: "test-secret", passphrase: "test-pass" });

  assert.equal(new URL(requestedUrl).pathname, "/api/v5/finance/staking-defi/offers");
  assert.equal(new URL(requestedUrl).search, "");
  assert.equal(fetchOptions.retry, false);
  assert.ok(requestInit.headers["OK-ACCESS-SIGN"]);
  assert.equal(requestInit.headers["OK-ACCESS-KEY"], "test-key");
  assert.deepEqual(result, {
    byAsset: {
      USDT: { rowCount: 2, rows: [
        { id: "offer-123", asset: "USDT", protocol: "Example Staking", protocolType: "staking", status: "available", term: "0", apy: "4.25" },
        { id: "bad-rate", asset: "USDT", protocol: "Odd" },
      ] },
      USDC: { rowCount: 0, rows: [] },
      USDGO: { rowCount: 0, rows: [] },
      BTC: { rowCount: 1, rows: [{ id: "other-asset", asset: "BTC", protocol: "Other", apy: "3" }] },
    },
  });
  const json = JSON.stringify(result);
  assert.equal(json.includes("9000"), false);
  assert.equal(json.includes("42"), false);
  assert.equal(json.includes("test-secret"), false);
  assert.equal(json.includes("<script>"), false);
});

test("OKX On-chain offers reject failed authenticated API responses", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async () => ({ ok: true, status: 200 }),
      readExchangeJson: async () => ({ code: "50103", msg: "Invalid API key", data: [] }),
    },
  }, { crypto: webcrypto });
  const { fetchOkxOnchainOffers } = load("@/lib/integrations/okx");
  await assert.rejects(
    fetchOkxOnchainOffers({ apiKey: "key", apiSecret: "secret", passphrase: "pass" }),
    /OKX read-only API failed \(200\/50103\)/,
  );
});

test("OKX rate-limit responses are not retried or sent to a fallback host", async () => {
  let calls = 0;
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async () => { calls += 1; return { ok: false, status: 429 }; },
      readExchangeJson: async () => ({ code: "0", data: [] }),
    },
  }, { crypto: webcrypto });
  const { fetchOkxOnchainOffers } = load("@/lib/integrations/okx");
  await assert.rejects(
    fetchOkxOnchainOffers({ apiKey: "key", apiSecret: "secret", passphrase: "pass" }),
    /OKX read-only API failed \(429\/0\)/,
  );
  assert.equal(calls, 1);
});
