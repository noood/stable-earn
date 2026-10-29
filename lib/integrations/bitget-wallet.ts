/** The first wallet integration deliberately follows one verified Morph vault. */
export const BGW_ACCOUNT_ID = "bitget-wallet-morph";
export const BGW_CHAIN_ID = 2818;
export const BGW_VAULT_ADDRESS = "0x9131eb40bd0bdce73c72755f1bb2cf39a9453341";
export const BGW_IDENTITY_KEY = `${BGW_ACCOUNT_ID}:${BGW_CHAIN_ID}:${BGW_VAULT_ADDRESS}`;

const rpcEndpoints = ["https://rpc.morph.network", "https://rpc-bgw.morph.network"] as const;
const endpointTimeoutMs = 8_000;
const maxSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);
const zero = BigInt(0);
const microUsdc = 1_000_000;
const readFailure = "Bitget Wallet · Morph 持仓读取失败";

export type BitgetWalletHolding = {
  amount: number;
  /** The pinned block's timestamp, rather than the local request completion time. */
  updatedAt: string;
  blockNumber: string;
};

/** Read-only: no wallet signature, transaction history, allowance or trade calls. */
export async function fetchBitgetWalletHolding(address: string): Promise<BitgetWalletHolding> {
  if (typeof address !== "string" || !/^0x[0-9a-f]{40}$/i.test(address)) {
    throw new Error("Morph 钱包地址格式不正确");
  }
  for (const endpoint of rpcEndpoints) {
    try {
      return await readEndpoint(endpoint, address.toLowerCase());
    } catch {
      // Providers are independent. Retry the entire pinned read on the fallback,
      // never splice a share balance and a price from different providers/blocks.
    }
  }
  // Do not expose a provider response, wallet address or holdings in errors/logs.
  throw new Error(readFailure);
}

async function readEndpoint(endpoint: string, address: string): Promise<BitgetWalletHolding> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextId = 0;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(readFailure));
    }, endpointTimeoutMs);
  });

  async function call(method: string, params: unknown[]) {
    if (controller.signal.aborted) throw new Error(readFailure);
    const id = ++nextId;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok || controller.signal.aborted) throw new Error(readFailure);
    const payload: unknown = await response.json();
    if (controller.signal.aborted || !payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(readFailure);
    const record = payload as Record<string, unknown>;
    if (record.jsonrpc !== "2.0" || record.id !== id || "error" in record || !("result" in record)) throw new Error(readFailure);
    return record.result;
  }

  async function read() {
    if (parseQuantity(await call("eth_chainId", [])) !== BigInt(BGW_CHAIN_ID)) throw new Error(readFailure);
    const rawBlock = await call("eth_blockNumber", []);
    const blockNumber = parseQuantity(rawBlock);
    if (blockNumber <= zero) throw new Error(readFailure);
    const pinnedBlock = `0x${blockNumber.toString(16)}`;
    const block = await call("eth_getBlockByNumber", [pinnedBlock, false]);
    if (!block || typeof block !== "object" || Array.isArray(block)) throw new Error(readFailure);
    const record = block as Record<string, unknown>;
    if (parseQuantity(record.number) !== blockNumber) throw new Error(readFailure);
    const timestamp = parseQuantity(record.timestamp);
    if (timestamp <= zero || timestamp > maxSafeInteger / BigInt(1000)) throw new Error(readFailure);
    const blockTime = Number(timestamp) * 1000;
    const date = new Date(blockTime);
    if (!Number.isFinite(date.getTime()) || blockTime > Date.now() + 5 * 60_000) throw new Error(readFailure);

    const shares = parseUint256(await call("eth_call", [{
      to: BGW_VAULT_ADDRESS,
      data: `0x70a08231${address.slice(2).padStart(64, "0")}`,
    }, pinnedBlock]));
    const assets = parseUint256(await call("eth_call", [{
      to: BGW_VAULT_ADDRESS,
      data: `0x07a2d13a${shares.toString(16).padStart(64, "0")}`,
    }, pinnedBlock]));
    // Preserve the exact integer amount before converting its six decimal places.
    // A large result must fail rather than silently round or become Infinity.
    if (assets > maxSafeInteger || (shares === zero && assets !== zero)) throw new Error(readFailure);
    return { amount: Number(assets) / microUsdc, updatedAt: date.toISOString(), blockNumber: pinnedBlock };
  }

  try {
    return await Promise.race([read(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

function parseQuantity(value: unknown) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value) || value.length > 66) throw new Error(readFailure);
  return BigInt(value);
}

function parseUint256(value: unknown) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/i.test(value)) throw new Error(readFailure);
  return BigInt(value);
}
