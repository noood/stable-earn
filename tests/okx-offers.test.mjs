import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { moduleLoader } from "./helpers/load-ts.mjs";

test("OKX On-chain offers probe signs the currency query and returns only safe offer fields", async () => {
  let requestedUrl;
  let requestInit;
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url, init) => {
        requestedUrl = url;
        requestInit = init;
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
        ],
      }),
    },
  }, { crypto: webcrypto });

  const { fetchOkxOnchainOffers } = load("@/lib/integrations/okx");
  const result = await fetchOkxOnchainOffers({ apiKey: "test-key", apiSecret: "test-secret", passphrase: "test-pass" }, "USDT");

  assert.equal(new URL(requestedUrl).pathname, "/api/v5/finance/staking-defi/offers");
  assert.equal(new URL(requestedUrl).searchParams.get("ccy"), "USDT");
  assert.ok(requestInit.headers["OK-ACCESS-SIGN"]);
  assert.equal(requestInit.headers["OK-ACCESS-KEY"], "test-key");
  assert.deepEqual(result, {
    rows: [
      { id: "offer-123", asset: "USDT", protocol: "Example Staking", protocolType: "staking", status: "available", term: "0", apy: "4.25" },
      { id: "bad-rate", asset: "USDT", protocol: "Odd" },
    ],
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
    fetchOkxOnchainOffers({ apiKey: "key", apiSecret: "secret", passphrase: "pass" }, "USDC"),
    /OKX read-only API failed \(200\/50103\)/,
  );
});
