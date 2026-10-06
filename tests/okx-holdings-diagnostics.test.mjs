import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { moduleLoader } from "./helpers/load-ts.mjs";

test("OKX holding diagnostics identify missing or unreadable coin rows without logging balances", async () => {
  const diagnostics = [];
  const load = moduleLoader({
    "@/lib/exchange-fetch": {
      exchangeFetch: async () => ({ ok: true, status: 200 }),
      readExchangeJson: async () => ({
        code: "0",
        data: [
          { ccy: "USDC", amt: "123.45" },
          { ccy: "usdt", amt: "98765.4321" },
          { ccy: "ETH", amt: "999.99" },
        ],
      }),
    },
    "@/lib/sync-diagnostics": {
      syncDiagnostic: (event, fields) => diagnostics.push({ event, ...fields }),
    },
  }, { crypto: webcrypto });

  const { fetchOkxSavingsHoldings } = load("@/lib/integrations/okx");
  const result = await fetchOkxSavingsHoldings({ apiKey: "test-key", apiSecret: "test-secret", passphrase: "test-pass" });

  assert.deepEqual(result, {
    holdings: { "okx-usdc": 123.45, "okx-usdt": 98765.4321 },
    observedAssets: ["USDC", "USDT", "ETH"],
    invalidAssets: [],
    snapshotComplete: true,
  });
  assert.deepEqual(diagnostics, [{
    event: "okx_holding_response",
    endpoint: "/api/v5/finance/savings/balance",
    dataFieldPresent: true,
    dataIsArray: true,
    rowCount: 3,
    assetChecks: [
      { asset: "USDT", rowCount: 1, returnedCurrencyCodes: ["usdt"], amountFieldPresentCount: 1, amountValidCount: 1, adapterRecognizedCount: 1, usableByAdapterCount: 1 },
      { asset: "USDC", rowCount: 1, returnedCurrencyCodes: ["USDC"], amountFieldPresentCount: 1, amountValidCount: 1, adapterRecognizedCount: 1, usableByAdapterCount: 1 },
      { asset: "BTC", rowCount: 0, returnedCurrencyCodes: [], amountFieldPresentCount: 0, amountValidCount: 0, adapterRecognizedCount: 0, usableByAdapterCount: 0 },
    ],
    unclassifiedRowCount: 1,
    unreadableCurrencyRowCount: 0,
    duplicateAssetCodes: [],
    snapshotComplete: true,
  }]);
  const diagnosticJson = JSON.stringify(diagnostics);
  assert.equal(diagnosticJson.includes("123.45"), false);
  assert.equal(diagnosticJson.includes("98765.4321"), false);
  assert.equal(diagnosticJson.includes("999.99"), false);
  assert.equal(diagnosticJson.includes("test-secret"), false);
});
