import { AsyncLocalStorage } from "node:async_hooks";
import { accessFailureReason, diagnosticErrorKind, syncDiagnostic } from "./sync-diagnostics";

const DEFAULT_RETRY_DELAY_MS = 800;
const responses = new WeakMap<Response, { requestId: string; startedAt: number }>();
const capabilityProbeRequestLimit = 40;
const capabilityProbeConcurrencyLimit = 3;

type ProbeRequestStopReason = "request_limit" | "rate_limited";
type ProbeRequestGuard = {
  requestsStarted: number;
  activeRequests: number;
  waiters: Array<() => void>;
  stopReason: ProbeRequestStopReason | null;
  retryAfterSeconds?: number;
};
const probeRequestContext = new AsyncLocalStorage<ProbeRequestGuard>();

/** Run one capability scan with bounded outbound requests and no automatic retries. */
export async function withCapabilityProbeRequestGuard<T>(task: () => Promise<T>) {
  const guard: ProbeRequestGuard = {
    requestsStarted: 0,
    activeRequests: 0,
    waiters: [],
    stopReason: null,
  };
  const result = await probeRequestContext.run(guard, task);
  return {
    result,
    requestsStarted: guard.requestsStarted,
    requestLimit: capabilityProbeRequestLimit,
    concurrencyLimit: capabilityProbeConcurrencyLimit,
    stopReason: guard.stopReason,
    ...(guard.retryAfterSeconds !== undefined ? { retryAfterSeconds: guard.retryAfterSeconds } : {}),
  };
}

export async function exchangeFetch(input: string, init?: RequestInit, options: { retry?: boolean } = {}) {
  const probeGuard = probeRequestContext.getStore();
  let response = await guardedFetch(input, init, 1, probeGuard);
  // Capability reports are best-effort diagnostics: do not amplify rate limits
  // or server errors with automatic retries.
  if (probeGuard) return response;
  if (options.retry === false) return response;
  if (!isRetryableStatus(response.status)) return response;

  const delayMs = retryDelay(response.headers.get("Retry-After"));
  await response.body?.cancel().catch(() => undefined);
  await delay(delayMs);
  response = await guardedFetch(input, init, 2, probeGuard);
  return response;
}

async function guardedFetch(input: string, init: RequestInit | undefined, requestAttempt: number, guard?: ProbeRequestGuard) {
  if (!guard) return fetchWithDiagnostics(input, init, requestAttempt);
  await acquireProbeRequestSlot(guard);
  try {
    const response = await fetchWithDiagnostics(input, init, requestAttempt);
    if (response.status === 418 || response.status === 429) {
      stopProbeRequests(guard, "rate_limited", retryAfterSeconds(response.headers.get("Retry-After")));
    }
    return response;
  } finally {
    guard.activeRequests -= 1;
    guard.waiters.shift()?.();
  }
}

async function acquireProbeRequestSlot(guard: ProbeRequestGuard) {
  while (true) {
    if (guard.stopReason) throw new Error(`capability_probe_stopped:${guard.stopReason}`);
    if (guard.requestsStarted >= capabilityProbeRequestLimit) {
      stopProbeRequests(guard, "request_limit");
      throw new Error("capability_probe_stopped:request_limit");
    }
    if (guard.activeRequests < capabilityProbeConcurrencyLimit) {
      guard.activeRequests += 1;
      guard.requestsStarted += 1;
      return;
    }
    await new Promise<void>((resolve) => guard.waiters.push(resolve));
  }
}

function stopProbeRequests(guard: ProbeRequestGuard, reason: ProbeRequestStopReason, retryAfter?: number) {
  if (reason === "rate_limited" || guard.stopReason === null) guard.stopReason = reason;
  if (retryAfter !== undefined) {
    guard.retryAfterSeconds = Math.max(guard.retryAfterSeconds ?? 0, retryAfter);
  }
  for (const wake of guard.waiters.splice(0)) wake();
}

function retryAfterSeconds(value: string | null, now = Date.now()) {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  const seconds = Number(candidate);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const timestamp = Date.parse(candidate);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.ceil(Math.max(0, timestamp - now) / 1000);
}

const knownHosts = new Set(["api-gcp.binance.com", "api.binance.com", "api.bybit.com", "api.bytick.com", "api.bybit.eu", "api.bitget.com", "openapi.okx.com", "www.okx.com"]);
const knownPaths = new Set([
  "/sapi/v1/simple-earn/flexible/list", "/sapi/v1/simple-earn/flexible/position",
  "/sapi/v1/simple-earn/locked/list", "/sapi/v1/simple-earn/locked/position",
  "/v5/earn/product", "/v5/earn/position", "/v5/earn/fixed-term/product", "/v5/earn/fixed-term/position",
  "/api/v2/earn/savings/product", "/api/v2/earn/savings/assets", "/api/v2/public/time",
  "/api/v5/finance/savings/balance",
]);

async function fetchWithDiagnostics(input: string, init: RequestInit | undefined, requestAttempt: number) {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  // Never log a full signed URL, request headers, or arbitrary query values.
  const url = new URL(input);
  const asset = url.searchParams.get("coin") ?? url.searchParams.get("asset") ?? url.searchParams.get("ccy");
  const target = {
    requestId, requestAttempt,
    host: knownHosts.has(url.hostname) ? url.hostname : "custom_host",
    endpoint: knownPaths.has(url.pathname) ? url.pathname : "other_endpoint",
    ...(["USDT", "USDC", "USDGO", "BTC"].includes(asset ?? "") ? { asset } : {}),
  };
  try {
    const response = await fetch(input, init);
    responses.set(response, { requestId, startedAt });
    syncDiagnostic("exchange_http", { ...target, httpStatus: response.status,
      ...responseDiagnostics(response), durationMs: Date.now() - startedAt }, !response.ok);
    return response;
  } catch (error) {
    syncDiagnostic("exchange_http", { ...target, outcome: diagnosticErrorKind(error, init?.signal?.aborted), durationMs: Date.now() - startedAt }, true);
    throw error;
  }
}

export function logExchangePayload(response: Response, body: unknown, rawText = "") {
  const request = responses.get(response);
  if (!request) return;
  const record = body && typeof body === "object" ? body as Record<string, unknown> : null;
  const rawCode = record?.retCode ?? record?.code;
  const apiCode = rawCode === undefined ? "absent" : /^-?\d{1,10}$/.test(String(rawCode)) ? String(rawCode) : "non_numeric";
  const failed = !record || (apiCode !== "absent" && apiCode !== "0" && apiCode !== "00000");
  syncDiagnostic("exchange_payload", {
    requestId: request.requestId, httpStatus: response.status, apiCode,
    ...(isAccessFailure(response.status) ? { accessReason: accessFailureReason(response.status,
      [record?.msg, record?.retMsg, record?.message, rawText].filter((value) => typeof value === "string").join(" ")) } : {}),
    bodyKind: record ? "json" : "invalid_json", durationMs: Date.now() - request.startedAt,
  }, !response.ok || failed);
}

export async function readExchangeJson<T>(response: Response): Promise<T> {
  let rawText = "";
  const body = await readExchangeBody(response, async () => {
    rawText = await response.text();
    return JSON.parse(rawText) as T;
  }, () => rawText);
  logExchangePayload(response, body, rawText);
  return body;
}

export function readExchangeText(response: Response): Promise<string> {
  return readExchangeBody(response, () => response.text());
}

async function readExchangeBody<T>(response: Response, read: () => Promise<T>, diagnosticText = () => ""): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const request = responses.get(response);
    if (request) syncDiagnostic("exchange_body_error", {
      requestId: request.requestId, httpStatus: response.status,
      ...(isAccessFailure(response.status) ? { accessReason: accessFailureReason(response.status, diagnosticText()) } : {}),
      errorKind: diagnosticErrorKind(error), durationMs: Date.now() - request.startedAt,
    }, true);
    throw error;
  }
}

function isAccessFailure(status: number) {
  return status === 403 || status === 451 || status === 429;
}

function responseDiagnostics(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  const fields: Record<string, string> = {
    responseType: contentType.includes("json") ? "json" : contentType.includes("html") ? "html" : "other",
  };
  // Only named upstream trace headers, with strict shape and length checks.
  const allowed = [
    ["cf-ray", /^[a-f0-9]{16,32}(?:-[A-Z]{3})?$/i],
    ["x-request-id", /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i],
    ["x-amz-cf-id", /^[A-Za-z0-9_+/=-]{40,100}$/],
  ] as const;
  for (const [header, shape] of allowed) {
    const value = response.headers.get(header);
    if (value && shape.test(value)) fields[header] = value;
  }
  return fields;
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
