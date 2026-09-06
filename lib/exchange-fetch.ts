import { diagnosticErrorKind, syncDiagnostic } from "./sync-diagnostics";

const DEFAULT_RETRY_DELAY_MS = 800;
const responses = new WeakMap<Response, { requestId: string; startedAt: number }>();

export async function exchangeFetch(input: string, init?: RequestInit) {
  let response = await fetchWithDiagnostics(input, init, 1);
  if (!isRetryableStatus(response.status)) return response;

  const delayMs = retryDelay(response.headers.get("Retry-After"));
  await response.body?.cancel().catch(() => undefined);
  await delay(delayMs);
  response = await fetchWithDiagnostics(input, init, 2);
  return response;
}

const knownHosts = new Set(["api-gcp.binance.com", "api.binance.com", "api.bybit.com", "api.bytick.com", "api.bybit.eu", "api.bitget.com", "openapi.okx.com", "www.okx.com"]);
const knownPaths = new Set([
  "/sapi/v1/simple-earn/flexible/list", "/sapi/v1/simple-earn/flexible/position",
  "/v5/earn/product", "/v5/earn/position", "/v5/earn/fixed-term/product", "/v5/earn/fixed-term/position",
  "/api/v2/earn/savings/product", "/api/v2/earn/savings/assets", "/api/v2/public/time",
  "/api/v5/finance/savings/balance",
]);

async function fetchWithDiagnostics(input: string, init: RequestInit | undefined, requestAttempt: number) {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  // Never log a full signed URL, request headers, or arbitrary query values.
  const url = new URL(input);
  const asset = url.searchParams.get("coin") ?? url.searchParams.get("asset");
  const target = {
    requestId, requestAttempt,
    host: knownHosts.has(url.hostname) ? url.hostname : "custom_host",
    endpoint: knownPaths.has(url.pathname) ? url.pathname : "other_endpoint",
    ...(["USDT", "USDC", "USDGO", "BTC"].includes(asset ?? "") ? { asset } : {}),
  };
  try {
    const response = await fetch(input, init);
    responses.set(response, { requestId, startedAt });
    syncDiagnostic("exchange_http", { ...target, httpStatus: response.status, durationMs: Date.now() - startedAt }, !response.ok);
    return response;
  } catch (error) {
    syncDiagnostic("exchange_http", { ...target, outcome: diagnosticErrorKind(error, init?.signal?.aborted), durationMs: Date.now() - startedAt }, true);
    throw error;
  }
}

export function logExchangePayload(response: Response, body: unknown) {
  const request = responses.get(response);
  if (!request) return;
  const record = body && typeof body === "object" ? body as Record<string, unknown> : null;
  const rawCode = record?.retCode ?? record?.code;
  const apiCode = rawCode === undefined ? "absent" : /^-?\d{1,10}$/.test(String(rawCode)) ? String(rawCode) : "non_numeric";
  const failed = !record || (apiCode !== "absent" && apiCode !== "0" && apiCode !== "00000");
  syncDiagnostic("exchange_payload", {
    requestId: request.requestId, httpStatus: response.status, apiCode,
    bodyKind: record ? "json" : "invalid_json", durationMs: Date.now() - request.startedAt,
  }, !response.ok || failed);
}

export async function readExchangeJson<T>(response: Response): Promise<T> {
  const body = await readExchangeBody(response, () => response.json()) as T;
  logExchangePayload(response, body);
  return body;
}

export function readExchangeText(response: Response): Promise<string> {
  return readExchangeBody(response, () => response.text());
}

async function readExchangeBody<T>(response: Response, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const request = responses.get(response);
    if (request) syncDiagnostic("exchange_body_error", {
      requestId: request.requestId, httpStatus: response.status,
      errorKind: diagnosticErrorKind(error), durationMs: Date.now() - request.startedAt,
    }, true);
    throw error;
  }
}

function isRetryableStatus(status: number) {
  return status === 429 || status >= 500;
}

function retryDelay(retryAfter: string | null) {
  const seconds = Number.parseFloat(retryAfter ?? "");
  if (!Number.isFinite(seconds)) return DEFAULT_RETRY_DELAY_MS;
  return Math.min(3000, Math.max(500, seconds * 1000));
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
