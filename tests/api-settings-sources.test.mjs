import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

test("Bybit EU has public product APR and manual holdings, without a useless Earn key entry", () => {
  const load = moduleLoader({ "cloudflare:workers": { env: {} } });
  const { credentialAccounts, credentialAccount, manualDataAccounts } = load("@/lib/credentials");
  const { accounts } = load("@/lib/seed-data");
  assert.deepEqual(Array.from(manualDataAccounts, (source) => source.id), ["bybit-eu", "mexc-ph", "mexc-uk"]);
  const eu = manualDataAccounts.find((source) => source.id === "bybit-eu");
  assert.equal(credentialAccount("bybit-eu"), null);
  assert.equal(eu.statusLabel, "手动维护");
  assert.match(eu.syncDescription, /产品 APR 由公开 API 提供（活期 USDT、USDC、BTC；定期四种资产）/);
  assert.match(eu.syncDescription, /持仓需手动维护/);
  assert.match(credentialAccount("binance-global").syncDescription, /四种资产的活期、定期产品、APR 与持仓/);
  assert.match(credentialAccount("bitget-global").syncDescription, /四种资产的活期、定期产品、APR 与持仓/);
  assert.equal(credentialAccount("bybit-global").syncDescription, "产品 APR 由公开 API 提供（活期 USDT、USDC、BTC；定期四种资产）；持仓自动同步");
  assert.match(credentialAccount("okx-global").syncDescription, /每币种对应一条跟踪产品，成功完整回包缺少币种行按 0/);
  assert.match(credentialAccount("okx-global").syncDescription, /产品 APR 需手动维护/);
  const sources = [...credentialAccounts, ...manualDataAccounts];
  assert.equal(new Set(sources.map((source) => source.id)).size, sources.length);
  assert.ok(sources.every((source) => accounts.some((account) => account.id === source.id)));
});

test("API check button state retains a generated download after the temporary success feedback", () => {
  const load = moduleLoader();
  const { apiCheckSuccessFeedbackMs, initialApiCheckUiState, transitionApiCheckUiState } = load("@/lib/api-check-ui-state");
  assert.equal(apiCheckSuccessFeedbackMs, 3000);
  const loading = transitionApiCheckUiState(initialApiCheckUiState, { type: "start" });
  assert.deepEqual(loading, { phase: "checking", downloadable: false, error: null });
  const completed = transitionApiCheckUiState(loading, { type: "report_generated" });
  assert.deepEqual(completed, { phase: "complete", downloadable: true, error: null });
  const afterFeedback = transitionApiCheckUiState(completed, { type: "feedback_elapsed" });
  assert.deepEqual(afterFeedback, { phase: "idle", downloadable: true, error: null });
  const restarted = transitionApiCheckUiState(afterFeedback, { type: "start" });
  assert.deepEqual(restarted, { phase: "checking", downloadable: false, error: null });
});

test("API check total failure does not expose a success state or a JSON download", () => {
  const load = moduleLoader();
  const { initialApiCheckUiState, transitionApiCheckUiState } = load("@/lib/api-check-ui-state");
  const loading = transitionApiCheckUiState(initialApiCheckUiState, { type: "start" });
  const failed = transitionApiCheckUiState(loading, { type: "failed", error: "报告生成失败" });
  assert.deepEqual(failed, { phase: "error", downloadable: false, error: "报告生成失败" });
});

test("partial API reports do not present success or expose a JSON download", () => {
  const load = moduleLoader();
  const { initialApiCheckUiState, transitionApiCheckUiState } = load("@/lib/api-check-ui-state");
  const loading = transitionApiCheckUiState(initialApiCheckUiState, { type: "start" });
  const limited = transitionApiCheckUiState(loading, { type: "partial_report" });

  assert.deepEqual(limited, { phase: "idle", downloadable: false, error: null });
});

test("API retry-after accepts seconds and uses a safe fallback when absent or invalid", () => {
  const load = moduleLoader();
  const { parseRetryAfterSeconds } = load("@/lib/api-check-ui-state");
  assert.equal(parseRetryAfterSeconds("292"), 292);
  assert.equal(parseRetryAfterSeconds(null), 60);
  assert.equal(parseRetryAfterSeconds("not a retry date"), 60);
});
