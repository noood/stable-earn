import { AsyncLocalStorage } from "node:async_hooks";

type Context = { runId: string; userRef: string; trigger: "scheduled" | "manual" | "initial"; attempt: number; platform?: string };
const context = new AsyncLocalStorage<Context>();

export async function withSyncDiagnostics<T>(
  userId: string,
  options: Pick<Context, "trigger" | "attempt"> & { runId?: string },
  task: () => Promise<T>,
) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`stable-earn-log:${userId}`));
  const userRef = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
  return context.run({ ...options, runId: options.runId ?? crypto.randomUUID(), userRef }, task);
}

export function withSyncPlatform<T>(platform: string, task: () => Promise<T>) {
  const current = context.getStore();
  return current ? context.run({ ...current, platform }, task) : task();
}

// Callers pass only controlled status fields, never upstream messages or data.
export function syncDiagnostic(event: string, fields: Record<string, unknown> = {}, warning = false) {
  const current = context.getStore();
  if (!current) return;
  const record = { event, ...current, ...fields };
  if (warning) console.warn(record);
  else console.info(record);
}

export function diagnosticErrorKind(error: unknown, aborted = false) {
  // Match known runtime wording; never emit the original exception text.
  if (error instanceof Error && /too many subrequests|subrequests? limit exceeded/i.test(error.message)) return "subrequest_limit_exceeded";
  if (aborted || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) return "timeout_or_abort";
  if (error instanceof SyntaxError) return "invalid_json";
  if (error instanceof TypeError) return "network_or_type_error";
  if (error instanceof Error) {
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
  if (status === 429) return "rate_limited";
  return "access_denied_unknown";
}
