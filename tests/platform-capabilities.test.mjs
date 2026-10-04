import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

test("platform capability matrix covers every monitored account, asset, and product type", async () => {
  const load = moduleLoader();
  const { monitoredAssets, platformCapabilities, platformCapability } = load("@/lib/platform-capabilities");
  const { accounts: seedAccounts } = load("@/lib/seed-data");
  const accountIds = [
    "binance-global", "binance-bahrain", "bybit-global", "bybit-eu",
    "bitget-global", "okx-global", "mexc-ph", "mexc-uk",
  ];
  assert.deepEqual(seedAccounts.map((account) => account.id), accountIds);
  assert.equal(platformCapabilities.length, accountIds.length * monitoredAssets.length * 2);
  for (const accountId of accountIds) {
    for (const asset of monitoredAssets) {
      for (const productType of ["flexible", "fixed"]) {
        assert.ok(platformCapability(accountId, productType, asset));
      }
    }
  }
});

test("matrix separates available API fields from explicit daily-sync scopes", async () => {
  const load = moduleLoader();
  const { apiAssetsFor, publicProductAssetsFor, platformCapability } = load("@/lib/platform-capabilities");

  assert.deepEqual(apiAssetsFor("binance-global", "flexible", "productApi"), ["USDT", "USDC", "USDGO", "BTC"]);
  assert.deepEqual(apiAssetsFor("binance-global", "fixed", "productApi"), ["USDT", "USDC", "USDGO", "BTC"]);
  assert.deepEqual(apiAssetsFor("bybit-global", "flexible", "holdingApi"), ["USDT", "USDC", "BTC"]);
  assert.deepEqual(apiAssetsFor("bybit-global", "fixed", "holdingApi"), ["USDT", "USDC", "USDGO", "BTC"]);
  assert.deepEqual(publicProductAssetsFor("bybit-global", "flexible"), ["USDT", "USDC", "BTC"]);
  assert.deepEqual(publicProductAssetsFor("bybit-eu", "flexible"), ["USDT", "USDC", "BTC"]);
  assert.deepEqual(apiAssetsFor("bitget-global", "flexible", "productApi"), ["USDT", "USDC", "USDGO", "BTC"]);
  assert.deepEqual(apiAssetsFor("okx-global", "flexible", "holdingApi"), ["USDT", "USDC", "BTC"]);
  assert.deepEqual(apiAssetsFor("mexc-ph", "flexible", "productApi"), []);
  assert.equal(platformCapability("okx-global", "flexible", "USDT").productApi, "unsupported");
  assert.equal(platformCapability("okx-global", "flexible", "USDT").productDailySync, false);
  assert.equal(platformCapability("okx-global", "flexible", "USDT").holdingDailySync, true);
  assert.equal(platformCapability("bybit-eu", "fixed", "BTC").holdingApi, "unsupported");
  assert.equal(platformCapability("bybit-eu", "fixed", "BTC").productDailySync, true);
});

test("each capability scope has endpoint metadata and explicit holding-zero semantics", () => {
  const load = moduleLoader();
  const { authoritativeEmptyHoldingScopeKeys, capabilityApiReference, monitoredAssets, platformCapabilities } = load("@/lib/platform-capabilities");
  for (const capability of platformCapabilities) {
    for (const field of ["productApi", "holdingApi"]) {
      const reference = capabilityApiReference(capability.accountId, capability.asset, capability.productType, field);
      assert.equal(typeof reference.permission, "string");
      assert.ok(reference.officialDocs.length > 0);
      if (capability[field] === "unsupported" && capability.exchange !== "bybit") {
        assert.equal(reference.path, null);
      }
      if (field === "holdingApi") assert.ok(["yes", "no", "unverified"].includes(reference.emptyHoldingMeansZero));
    }
  }
  assert.equal(capabilityApiReference("binance-global", "USDT", "flexible", "productApi").path, "/sapi/v1/simple-earn/flexible/list");
  assert.equal(capabilityApiReference("bybit-eu", "USDT", "flexible", "holdingApi").path, null);
  assert.equal(capabilityApiReference("bybit-global", "USDGO", "flexible", "holdingApi").emptyHoldingMeansZero, "no");
  assert.equal(capabilityApiReference("okx-global", "USDC", "flexible", "holdingApi").emptyHoldingMeansZero, "no");
  assert.equal(capabilityApiReference("bitget-global", "BTC", "fixed", "holdingApi").emptyHoldingMeansZero, "yes");
  assert.match(capabilityApiReference("bybit-global", "USDT", "flexible", "holdingApi").emptyHoldingEvidence, /全部赎回/);
  assert.match(capabilityApiReference("bybit-global", "USDT", "fixed", "holdingApi").emptyHoldingEvidence, /Active positions/);
  assert.equal(platformCapabilities.length / (monitoredAssets.length * 2), 8);

  const bybitZeroScopes = authoritativeEmptyHoldingScopeKeys(["bybit-global"]);
  assert.ok(bybitZeroScopes.includes("bybit-global:USDT:flexible"));
  assert.ok(bybitZeroScopes.includes("bybit-global:USDGO:fixed"));
  assert.ok(!bybitZeroScopes.includes("bybit-global:USDGO:flexible"));
  assert.deepEqual(authoritativeEmptyHoldingScopeKeys(["okx-global"]), []);
  assert.deepEqual(authoritativeEmptyHoldingScopeKeys(["bybit-eu", "mexc-ph", "mexc-uk"]), []);
});

test("capability document contains a merged 112-item matrix with API support before recent results", () => {
  const load = moduleLoader();
  const { monitoredAssets } = load("@/lib/platform-capabilities");
  const document = readFileSync(new URL("../docs/PLATFORM-CAPABILITIES.md", import.meta.url), "utf8");
  const section = document.split("## 全量逐项能力表（112 项）")[1]?.split("## 空、部分、失败及目录处理规则")[0] ?? "";
  const tableRows = [...section.matchAll(/<tr>(.*?)<\/tr>/gs)].map((match) => match[1]);
  const headers = [...(tableRows[0]?.matchAll(/<th>(.*?)<\/th>/g) ?? [])].map((match) => match[1]);
  const dataRows = tableRows.slice(1);
  assert.equal(monitoredAssets.length, 4);
  assert.equal(dataRows.length, 112);
  assert.deepEqual(headers.slice(0, 7), ["平台/地区", "币种", "期限", "信息项", "是否支持 API", "最近结果", "最近检查/依据日期"]);
  assert.equal((section.match(/<td rowspan="16">/g) ?? []).length, 7);
  assert.equal((section.match(/<td rowspan="4">/g) ?? []).length, 28);
  assert.equal((section.match(/<td rowspan="2">/g) ?? []).length, 56);
  assert.equal(dataRows.every((row) => /<td>(支持|不支持|待确认)<\/td>/.test(row)), true);
  assert.equal(dataRows.filter((row) => row.includes("MEXC（PH/UK）")).length, 1);
  assert.equal(section.includes("PH 官方目录"), true);
  assert.equal(section.includes("UK 官方目录"), true);
  assert.match(section, /依据项目已核验并配置的接口能力[\s\S]*?不会改变这项能力结论/);
  const holdingRows = dataRows.filter((row) => row.includes("<td>持仓</td>"));
  assert.equal(holdingRows.length, 56);
  assert.equal(holdingRows.every((row) => row.includes("账户结果不公开") || row.includes("未查询：项目无可用接口")), true);
  assert.doesNotMatch(document, /Bybit Global USDC 活期持仓曾返回|有数据（\d+ 条，正持仓）/);
});
