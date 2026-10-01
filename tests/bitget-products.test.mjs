import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

test("Bitget keeps separate offers and assigns holdings by productId", async () => {
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async (url) => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        url,
        text: async () => "",
      }),
      readExchangeText: async (response) => {
        const parsed = new URL(response.url);
        if (parsed.pathname.endsWith("/savings/assets")) {
          return JSON.stringify({ code: "00000", data: { resultList: [
            { productId: "bg-usdt-standard", productCoin: "USDT", periodType: "flexible", holdAmount: "300", productLevel: "normal", apy: [{ minApy: "0", maxApy: "300", currentApy: "8.06" }] },
            { productId: "bg-usdt-promo", productCoin: "USDT", periodType: "flexible", holdAmount: "0", productLevel: "normal", apy: [{ minApy: "0", maxApy: "100000", currentApy: "10" }] },
            { productId: "USDC-shared", productCoin: "USDC", periodType: "flexible", holdAmount: "0", productLevel: "normal", apy: [{ minApy: "0", maxApy: "300", currentApy: "6" }] },
            { productId: "USDGO-default", productCoin: "USDGO", periodType: "flexible", holdAmount: "0", productLevel: "normal", apy: [{ minApy: "0", maxApy: "300", currentApy: "6" }] },
          ] } });
        }
        const coin = parsed.searchParams.get("coin");
        const rows = coin === "USDT"
          ? [
            { productId: "bg-usdt-standard", coin: "USDT", periodType: "flexible", status: "available", apyList: [{ minStepVal: "0", maxStepVal: "300", currentApy: "8.06" }] },
            { productId: "bg-usdt-promo", coin: "USDT", periodType: "flexible", status: "available", apyList: [{ minStepVal: "0", maxStepVal: "100000", currentApy: "10" }] },
          ]
          : coin === "USDC"
            ? [
              { productId: "USDC-shared", coin: "USDC", periodType: "flexible", status: "available", apyList: [{ minStepVal: "0", maxStepVal: "300", currentApy: "8" }] },
              { productId: "USDC-shared", coin: "USDC", periodType: "flexible", status: "available", apyList: [{ minStepVal: "0", maxStepVal: "100000", currentApy: "10" }] },
            ]
          : [{ productId: `${coin}-default`, coin, periodType: "flexible", status: "available", apyList: [{ minStepVal: "0", maxStepVal: "300", currentApy: "6" }] }];
        return JSON.stringify({ code: "00000", data: rows });
      },
      readExchangeJson: async () => ({ code: "00000", data: { serverTime: "1" } }),
      logExchangePayload: () => {},
    },
  });
  const { fetchBitgetSavingsSnapshot } = load("@/lib/integrations/bitget");
  const result = await fetchBitgetSavingsSnapshot({ apiKey: "key", apiSecret: "secret", passphrase: "pass" });

  const usdtRates = result.rates.filter((rate) => rate.catalog?.asset === "USDT");
  assert.equal(usdtRates.length, 2);
  assert.deepEqual(usdtRates.map((rate) => rate.externalProductId).sort(), ["bg-usdt-promo", "bg-usdt-standard"]);
  const usdcRates = result.rates.filter((rate) => rate.catalog?.asset === "USDC");
  assert.equal(usdcRates.length, 1);
  assert.equal(usdcRates[0].tiers.length, 1);
  assert.equal(result.holdings["bg-usdt-standard"], 300);
  assert.equal(result.holdings["bg-usdt-promo"], 0);
  assert.equal(result.sync.products, true);
  assert.equal(result.sync.holdings, true);
});
