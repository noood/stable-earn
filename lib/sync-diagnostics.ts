import { AsyncLocalStorage } from "node:async_hooks";

type DiagnosticRecord = { event: string; [key: string]: unknown };
type Context = {
  runId: string;
  userRef: string;
  trigger: "scheduled" | "manual" | "daily";
  attempt: number;
  platform?: string;
  captured?: DiagnosticRecord[];
  suppressOutput?: boolean;
};
const context = new AsyncLocalStorage<Context>();

/** Capture existing adapter diagnostics without emitting them to runtime logs. */
export async function collectSyncDiagnostics<T>(task: () => Promise<T>) {
  const captured: DiagnosticRecord[] = [];
  const parent = context.getStore();
  const result = await context.run({
    ...(parent ?? { runId: crypto.randomUUID(), userRef: "capability-check", trigger: "manual" as const, attempt: 1 }),
    captured,
    suppressOutput: true,
  }, task);
  return { result, captured };
}

export async function withSyncDiagnostics<T>(
  userId: string,
  options: Pick<Context, "trigger" | "attempt"> & { runId?: string },
  task: () => Promise<T>,
) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`stable-earn-log:${userId}`));
  const userRef = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
  return context.run({
    ...options,
    runId: options.runId ?? crypto.randomUUID(),
    userRef,
    ...(context.getStore()?.captured ? { captured: context.getStore()?.captured } : {}),
    ...(context.getStore()?.suppressOutput ? { suppressOutput: true } : {}),
  }, task);
}

export function withSyncPlatform<T>(platform: string, task: () => Promise<T>) {
  const current = context.getStore();
  return current ? context.run({ ...current, platform }, task) : task();
}

const privatePositionFieldsByEvent: Record<string, readonly string[]> = {
  binance_flexible_rows: ["positionTotal", "positionRowCount", "positionScopeMismatchCount", "positionRows"],
  binance_locked_rows: ["positionTotal", "positionRowCount", "positionRows"],
  binance_catalog_decisions: ["decisions"],
  bybit_flexible_position_rows: ["rowCount", "scopeMismatchCount", "missingIdentityCount", "invalidAmountCount", "rows", "productTotals"],
  bybit_fixed_rows: ["positionRowCount", "unresolvedPositionCount", "invalidPositionAmountCount", "positionRows"],
  bitget_assets_rows: ["requestedLimit", "pageCount", "rowCount", "pages", "rows"],
  bitget_assets_pagination: ["requestedLimit", "pageCount", "rowCount", "pages"],
  bitget_holdings_normalized: ["holdings"],
  bitget_holding_mapping: ["adapterHoldings", "adapterToCatalog", "freshCatalogHoldings", "cachedCatalogHoldings", "finalCatalogHoldings", "finalFallbacks"],
  bitget_fixed_rows: ["positionRowCount", "positionRows"],
  bitget_capability_probe: ["holdingsApiRowCount", "holdingsApiPages"],
};

function safeRuntimeRecord(record: DiagnosticRecord) {
  const hiddenFields = new Set(privatePositionFieldsByEvent[String(record.event)] ?? []);
  return Object.fromEntries(Object.entries(record).filter(([key]) => !hiddenFields.has(key)));
}

// Adapter diagnostics may inspect detailed position rows in memory for a
// one-off probe, but runtime logs must never contain account position data.
export function syncDiagnostic(event: string, fields: Record<string, unknown> = {}, warning = false) {
  const current = context.getStore();
  if (!current) return;
  const record = { event, ...current, ...fields };
  current.captured?.push(record);
  if (current.suppressOutput) return;
  const safeRecord = safeRuntimeRecord(record);
  if (warning) console.warn(safeRecord);
  else console.info(safeRecord);
}

export function diagnosticErrorKind(error: unknown, aborted = false) {
  // Match known runtime wording; never emit the original exception text.
  if (error instanceof Error && /too many subrequests|subrequests? limit exceeded/i.test(error.message)) return "subrequest_limit_exceeded";
  if (aborted || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) return "timeout_or_abort";
  if (error instanceof SyntaxError) return "invalid_json";
  if (error instanceof TypeError) return "network_or_type_error";
  if (error instanceof Error) {
    if (error.message === "refresh lease expired") return "refresh_superseded";
    if (error.message === "公开与账户接口均未返回可用数据") return "no_usable_data";
    if (error.message === "已配置平台未完整同步") return "incomplete_sync";
    if (/^(Binance|Bybit) returned no\b/.test(error.message)) return "missing_product_or_apr";
  }
  return "error";
}

export function accessFailureReason(status: number, text: string) {
  const sample = text.slice(0, 16_384);
  if (/restricted location|country.{0,40}(?:block(?:ed)?|restricted)|(?:block(?:ed)?|restricted).{0,40}country|region.{0,30}not supported/i.test(sample)) return "region_restricted";
  if (/access too frequent|too many requests|rate limit (?:exceeded|breached)|request (?:frequency|rate).{0,20}exceeded/i.test(sample)) return "rate_limited";
  if (/(?:ip|address).{0,40}(?:not (?:in|on).{0,10}whitelist|not whitelisted)|unmatched ip|ip.{0,20}(?:mismatch|not allowed)/i.test(sample)) return "ip_not_allowed";
  if (status === 418 || status === 429) return "rate_limited";
  return "access_denied_unknown";
}
