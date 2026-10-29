import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

const address = "0x1111111111111111111111111111111111111111";
const blockNumber = "0x1ba3b00";
const blockTimestamp = "0x6ae1f000";
const uint = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;

function adapter(overrides = {}, globals = {}) {
  const calls = [];
  const results = {
    eth_chainId: "0xb02",
    eth_blockNumber: blockNumber,
    eth_getBlockByNumber: { number: blockNumber, timestamp: blockTimestamp },
    balanceOf: uint("123000000000000000000"),
    convertToAssets: uint(123_456789),
    ...overrides,
  };
  const fetch = async (endpoint, init) => {
    const request = JSON.parse(init.body);
    const key = request.method === "eth_call"
      ? request.params[0].data.startsWith("0x70a08231") ? "balanceOf" : "convertToAssets"
      : request.method;
    calls.push({ endpoint, init, request, key });
    const result = typeof results[key] === "function" ? await results[key](calls.at(-1)) : results[key];
    if (result instanceof Error) throw result;
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  };
  const api = moduleLoader({}, { fetch, ...globals })("@/lib/integrations/bitget-wallet");
  return { api, calls };
}

test("wallet shares convert to USDC at the same pinned block and use its timestamp", async () => {
  const { api, calls } = adapter();
  const result = await api.fetchBitgetWalletHolding(address);
  assert.deepEqual(result, {
    amount: 123.456789,
    updatedAt: new Date(Number(BigInt(blockTimestamp)) * 1000).toISOString(),
    blockNumber,
  });
  assert.equal(api.BGW_CHAIN_ID, 2818);
  assert.equal(api.BGW_ACCOUNT_ID, "bitget-wallet-morph");
  assert.equal(api.BGW_IDENTITY_KEY, `bitget-wallet-morph:2818:${api.BGW_VAULT_ADDRESS}`);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.filter((call) => call.request.method === "eth_call").map((call) => call.request.params[1]), [blockNumber, blockNumber]);
  assert.deepEqual(calls[2].request.params, [blockNumber, false]);
  assert.equal(calls[3].request.params[0].to, api.BGW_VAULT_ADDRESS);
  assert.equal(calls[3].request.params[0].data, `0x70a08231${address.slice(2).padStart(64, "0")}`);
  assert.equal(calls[4].request.params[0].data, `0x07a2d13a${BigInt("123000000000000000000").toString(16).padStart(64, "0")}`);
  assert.ok(calls.every((call) => call.init.method === "POST" && call.init.cache === "no-store"));
  assert.ok(calls.every((call) => ["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_call"].includes(call.request.method)));
});

test("a validated zero share/asset result is a real zero holding", async () => {
  const { api } = adapter({ balanceOf: uint(0), convertToAssets: uint(0) });
  assert.equal((await api.fetchBitgetWalletHolding(address)).amount, 0);
});

test("dust shares can legitimately round down to zero micro-USDC", async () => {
  const { api } = adapter({ balanceOf: uint(1), convertToAssets: uint(0) });
  assert.equal((await api.fetchBitgetWalletHolding(address)).amount, 0);
});

test("a failed primary read restarts the whole pinned snapshot at the fallback", async () => {
  let attempts = 0;
  const { api, calls } = adapter({ balanceOf: () => ++attempts === 1 ? new Error("provider failed") : uint(1) });
  assert.equal((await api.fetchBitgetWalletHolding(address)).amount, 123.456789);
  const fallback = calls.findIndex((call) => call.endpoint === "https://rpc-bgw.morph.network");
  assert.ok(fallback > 0);
  assert.equal(calls[fallback].request.method, "eth_chainId");
  assert.equal(calls.filter((call) => call.request.method === "eth_blockNumber").length, 2);
});

test("invalid addresses are rejected before making any outbound request", async () => {
  const { api, calls } = adapter();
  for (const invalid of [null, "", "0x1234", ` ${address}`, `https://example.com/${address}`, `${address.slice(0, -1)}g`]) {
    await assert.rejects(api.fetchBitgetWalletHolding(invalid), /地址格式/);
  }
  assert.equal(calls.length, 0);
});

test("wrong chain, mismatched block and malformed call results never become a zero", async () => {
  const invalidCases = [
    { eth_chainId: "0x1" },
    { eth_chainId: "2818" },
    { eth_blockNumber: "0x00" },
    { eth_getBlockByNumber: null },
    { eth_getBlockByNumber: { number: "0x1", timestamp: blockTimestamp } },
    { eth_getBlockByNumber: { number: blockNumber, timestamp: "0x0" } },
    { eth_getBlockByNumber: { number: blockNumber, timestamp: "0xffffffffffffffff" } },
    { balanceOf: "0x" },
    { balanceOf: "0x0" },
    { convertToAssets: null },
    { convertToAssets: uint(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1)) },
    { balanceOf: uint(0), convertToAssets: uint(1) },
  ];
  for (const invalid of invalidCases) {
    const { api } = adapter(invalid);
    await assert.rejects(api.fetchBitgetWalletHolding(address), /^Error: Bitget Wallet · Morph 持仓读取失败$/);
  }
});

test("HTTP, JSON-RPC and response-envelope failures are rejected with a sanitized error", async () => {
  for (const fetch of [
    async () => new Response("secret response", { status: 500 }),
    async () => new Response("not JSON"),
    async () => Response.json({ jsonrpc: "2.0", id: 1, error: { message: address } }),
    async () => Response.json({ jsonrpc: "2.0", id: 999, result: "0xb02" }),
    async () => Response.json({ id: 1, result: "0xb02" }),
    async () => { throw new Error(address); },
  ]) {
    const { api } = adapter({}, { fetch });
    await assert.rejects(api.fetchBitgetWalletHolding(address), (error) => error.message === "Bitget Wallet · Morph 持仓读取失败" && !error.message.includes(address));
  }
});

test("a deadline also bounds a provider that never resolves and aborts both requests", async () => {
  const signals = [];
  const delays = [];
  const cleared = [];
  const { api } = adapter({}, {
    fetch: async (_endpoint, init) => { signals.push(init.signal); return new Promise(() => {}); },
    setTimeout: (callback, milliseconds) => { delays.push(milliseconds); queueMicrotask(callback); return delays.length; },
    clearTimeout: (id) => cleared.push(id),
  });
  await assert.rejects(api.fetchBitgetWalletHolding(address), /持仓读取失败/);
  assert.deepEqual(delays, [8000, 8000]);
  assert.deepEqual(cleared, [1, 2]);
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal.aborted));
});
