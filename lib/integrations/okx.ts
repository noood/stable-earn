import { exchangeFetch } from "@/lib/exchange-fetch";

type OkxCredentials = {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  baseUrl?: string;
};

type OkxSavingsRow = {
  ccy?: string;
  amt?: string;
  loanAmt?: string;
  pendingAmt?: string;
  redemptAmt?: string;
  rate?: string;
};

type OkxResponse = {
  code?: string;
  msg?: string;
  data?: OkxSavingsRow[];
};

const productIds = {
  USDT: "okx-usdt",
  USDC: "okx-usdc",
  BTC: "okx-btc",
} as const;

const okxApiBases = ["https://openapi.okx.com", "https://www.okx.com"] as const;

export async function fetchOkxSavingsHoldings(credentials: OkxCredentials) {
  const body = await signedGet("/api/v5/finance/savings/balance", credentials);
  const holdings: Record<string, number> = Object.fromEntries(
    Object.values(productIds).map((productId) => [productId, 0]),
  );

  for (const row of body.data ?? []) {
    const productId = row.ccy ? productIds[row.ccy as keyof typeof productIds] : undefined;
    if (productId) holdings[productId] = finiteNumber(row.amt);
  }
  return { holdings };
}

async function signedGet(path: string, credentials: OkxCredentials) {
  const baseUrls = credentials.baseUrl ? [credentials.baseUrl] : okxApiBases;
  let lastError: unknown;

  for (const baseUrl of baseUrls) {
    const timestamp = new Date().toISOString();
    const signature = await hmacBase64(`${timestamp}GET${path}`, credentials.apiSecret);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await exchangeFetch(`${baseUrl}${path}`, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "OK-ACCESS-KEY": credentials.apiKey,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": credentials.passphrase,
        },
      });
      const body = await response.json() as OkxResponse;
      if (!response.ok || body.code !== "0") {
        throw new Error(`OKX read-only API failed (${response.status}/${body.code ?? "unknown"})`);
      }
      return body;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("OKX read-only API unavailable");
}

async function hmacBase64(payload: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bytesToBase64(new Uint8Array(signature));
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function finiteNumber(value: string | number | undefined) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
}
