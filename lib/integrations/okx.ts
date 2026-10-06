import { exchangeFetch, readExchangeJson } from "@/lib/exchange-fetch";
import { parseExchangeNumber } from "@/lib/exchange-number";
import { syncDiagnostic } from "@/lib/sync-diagnostics";

type OkxCredentials = {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  baseUrl?: string;
};

type OkxSavingsRow = {
  ccy?: string;
  amt?: string | null;
  loanAmt?: string;
  pendingAmt?: string;
  redemptAmt?: string;
  rate?: string;
};

type OkxOnchainOfferRow = {
  ccy?: string;
  productId?: string | number;
  algoId?: string | number;
  protocol?: string;
  protocolType?: string;
  state?: string;
  status?: string;
  term?: string | number;
  apy?: string | number;
};

type OkxResponse = {
  code?: string;
  msg?: string;
  data?: Array<OkxSavingsRow & OkxOnchainOfferRow>;
};

const productIds = {
  USDT: "okx-usdt",
  USDC: "okx-usdc",
  BTC: "okx-btc",
} as const;
const onchainProbeAssets = ["USDT", "USDC", "USDGO", "BTC"] as const;
const maxOnchainOffersPerAsset = 20;

const okxApiBases = ["https://openapi.okx.com", "https://www.okx.com"] as const;

export async function fetchOkxSavingsHoldings(credentials: OkxCredentials) {
  const body = await signedGet("/api/v5/finance/savings/balance", credentials);
  if (!Array.isArray(body.data)) {
    syncDiagnostic("okx_holding_response", {
      endpoint: "/api/v5/finance/savings/balance",
      dataFieldPresent: Object.hasOwn(body, "data"),
      dataIsArray: false,
      rowCount: 0,
      snapshotComplete: false,
      assetChecks: [],
      unclassifiedRowCount: 0,
    }, true);
    throw new Error("OKX savings balance data is not a list");
  }
  const responseRows = body.data;

  const holdings: Record<string, number> = {};
  const observedAssets = new Set<string>();
  const invalidAssets = new Set<string>();
  const duplicateAssets = new Set<string>();
  const rowCounts = new Map<string, number>();
  let unreadableCurrencyRowCount = 0;

  for (const row of responseRows) {
    const asset = normalizedCurrency(row);
    if (!asset) {
      unreadableCurrencyRowCount += 1;
      continue;
    }
    observedAssets.add(asset);
    const productId = productIds[asset as keyof typeof productIds];
    if (!productId) continue;
    const rowCount = (rowCounts.get(asset) ?? 0) + 1;
    rowCounts.set(asset, rowCount);
    if (rowCount > 1) {
      duplicateAssets.add(asset);
      delete holdings[productId];
      continue;
    }
    const amount = parseExchangeNumber(row.amt);
    if (amount === undefined || amount < 0) {
      invalidAssets.add(asset);
      continue;
    }
    holdings[productId] = amount;
  }
  for (const asset of invalidAssets) delete holdings[productIds[asset as keyof typeof productIds]];
  for (const asset of duplicateAssets) delete holdings[productIds[asset as keyof typeof productIds]];

  const assetChecks = Object.keys(productIds).map((asset) => {
    const matchingRows = responseRows.filter((row) => normalizedCurrency(row) === asset);
    const parsedAmounts = matchingRows.map((row) => parseExchangeNumber(row.amt));
    const assetIsUnambiguous = matchingRows.length === 1
      && !invalidAssets.has(asset)
      && !duplicateAssets.has(asset);
    return {
      asset,
      rowCount: matchingRows.length,
      returnedCurrencyCodes: [...new Set(matchingRows.map((row) => safeCurrencyCode(row.ccy) ?? "unreadable"))].slice(0, 5),
      amountFieldPresentCount: matchingRows.filter((row) => Object.hasOwn(row, "amt")).length,
      amountValidCount: parsedAmounts.filter((amount) => amount !== undefined && amount >= 0).length,
      adapterRecognizedCount: matchingRows.length,
      usableByAdapterCount: assetIsUnambiguous && (parsedAmounts[0] ?? -1) >= 0 ? 1 : 0,
    };
  });
  const snapshotComplete = unreadableCurrencyRowCount === 0
    && invalidAssets.size === 0
    && duplicateAssets.size === 0;
  syncDiagnostic("okx_holding_response", {
    endpoint: "/api/v5/finance/savings/balance",
    dataFieldPresent: Object.hasOwn(body, "data"),
    dataIsArray: true,
    rowCount: responseRows.length,
    assetChecks,
    unclassifiedRowCount: responseRows.length - assetChecks.reduce((total, item) => total + item.rowCount, 0),
    unreadableCurrencyRowCount,
    duplicateAssetCodes: [...duplicateAssets],
    snapshotComplete,
  });
  return {
    holdings,
    observedAssets: [...observedAssets],
    invalidAssets: [...invalidAssets],
    snapshotComplete,
  };
}

function safeCurrencyCode(value: unknown) {
  if (typeof value !== "string") return null;
  const code = value.trim();
  return /^[A-Za-z0-9]{1,16}$/.test(code) ? code : null;
}

function normalizedCurrency(row: unknown) {
  if (!row || typeof row !== "object") return null;
  return safeCurrencyCode((row as OkxSavingsRow).ccy)?.toUpperCase() ?? null;
}

/**
 * Read documented On-chain Earn offers once and group the monitored currencies.
 * This is separate from ordinary Savings discovery and excludes investment,
 * earnings, and account-balance amounts from the upstream response.
 */
export async function fetchOkxOnchainOffers(credentials: OkxCredentials) {
  // ccy is optional on this documented listing endpoint. Fetch all offers once,
  // then keep only the four assets the app monitors to avoid a burst of calls.
  const body = await signedGet("/api/v5/finance/staking-defi/offers", credentials, { retry: false, fallback: false });
  const byAsset = Object.fromEntries(onchainProbeAssets.map((asset) => [asset, { rowCount: 0, rows: [] as ReturnType<typeof summarizeOnchainOffer>[] }]));
  for (const row of body.data ?? []) {
    const asset = row.ccy?.toUpperCase();
    if (!asset || !Object.hasOwn(byAsset, asset)) continue;
    const result = byAsset[asset as keyof typeof byAsset];
    result.rowCount += 1;
    if (result.rows.length < maxOnchainOffersPerAsset) result.rows.push(summarizeOnchainOffer(row));
  }
  return {
    byAsset,
  };
}

async function signedGet(path: string, credentials: OkxCredentials, options: { retry?: boolean; fallback?: boolean } = {}) {
  const baseUrls = credentials.baseUrl
    ? [credentials.baseUrl]
    : options.fallback === false
      ? [okxApiBases[0]]
      : okxApiBases;
  let lastError: unknown;

  for (const baseUrl of baseUrls) {
    const timestamp = new Date().toISOString();
    const signature = await hmacBase64(`${timestamp}GET${path}`, credentials.apiSecret);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    let responseStatus: number | undefined;
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
      }, { retry: options.retry });
      responseStatus = response.status;
      const body = await readExchangeJson<OkxResponse>(response);
      if (!response.ok || body.code !== "0") {
        throw new Error(`OKX read-only API failed (${response.status}/${body.code ?? "unknown"})`);
      }
      return body;
    } catch (error) {
      lastError = error;
      // One-off checks disable retries; do not amplify their rate-limit response
      // by attempting the same request against an alternate hostname.
      if (responseStatus === 429 && options.retry === false) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("OKX read-only API unavailable");
}

function summarizeOnchainOffer(row: OkxOnchainOfferRow) {
  return {
    id: safeIdentifier(row.productId ?? row.algoId),
    ...(safeLabel(row.ccy) ? { asset: safeLabel(row.ccy) } : {}),
    ...(safeLabel(row.protocol) ? { protocol: safeLabel(row.protocol) } : {}),
    ...(safeLabel(row.protocolType) ? { protocolType: safeLabel(row.protocolType) } : {}),
    ...(safeLabel(row.state ?? row.status) ? { status: safeLabel(row.state ?? row.status) } : {}),
    ...(safeLabel(row.term) ? { term: safeLabel(row.term) } : {}),
    ...(safeRate(row.apy) ? { apy: safeRate(row.apy) } : {}),
  };
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

function safeIdentifier(value: string | number | undefined) {
  const text = value === undefined ? "" : String(value);
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(text) ? text : null;
}

function safeLabel(value: string | number | undefined) {
  if (value === undefined) return undefined;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
  return text || undefined;
}

function safeRate(value: string | number | undefined) {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  return /^-?\d+(?:\.\d+)?%?$/.test(text) ? text : undefined;
}
