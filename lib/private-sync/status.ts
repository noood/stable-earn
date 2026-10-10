import type { HoldingSyncState, Product } from "@/lib/domain";
import type { ProductChangeSource } from "@/lib/product-change-events";
import { summarizePublicFailures } from "@/lib/live-rates";
import { sanitizeSyncFailure } from "@/lib/sync-notice";
import type { BinanceAccountSnapshot, PrivateDiagnostics, PrivateStatus, PrivateStatuses, RefreshOptions } from "./types";

export function refreshSource(trigger: RefreshOptions["trigger"]): ProductChangeSource {
  if (trigger === "daily") return "每日首次打开";
  if (trigger === "scheduled") return "定时刷新";
  return "手动刷新";
}

export function resolveBinanceStatus(snapshot: BinanceAccountSnapshot | null, fallback: PrivateStatus): PrivateStatus {
  if (!snapshot) return fallback;
  const statuses = Object.values(snapshot.apiStatuses);
  if (statuses.every((status) => status === "error")) return "error";
  if (statuses.every((status) => status === "complete")) return "synced";
  return "partial";
}

export function combineApiReadStatuses(statuses: Array<"complete" | "partial" | "error">) {
  if (statuses.length > 0 && statuses.every((status) => status === "error")) return "error" as const;
  return statuses.length > 0 && statuses.every((status) => status === "complete") ? "complete" as const : "partial" as const;
}

export function binanceScopes(snapshot: BinanceAccountSnapshot | null) {
  if (!snapshot) return undefined;
  const scopeLabels: Array<[keyof BinanceAccountSnapshot["apiStatuses"], string]> = [
    ["flexibleProducts", "活期产品"],
    ["flexibleHoldings", "活期持仓"],
    ["fixedProducts", "定期产品"],
    ["fixedHoldings", "定期持仓"],
  ];
  const scopes = scopeLabels.flatMap(([key, label]) => {
    const status = snapshot.apiStatuses[key];
    return status === "complete" ? [] : [`${label}${status === "error" ? "请求失败" : "部分返回"}`];
  });
  return scopes.length ? `scopes:${scopes.join("|")}` : undefined;
}

export function normalizeLegacyNote(note: string) {
  const messages: string[] = [];
  const publicFailure = note.match(/([^。]*公共 APR[^。]*本次获取失败)/)?.[1];
  if (publicFailure) {
    const platforms = extractPlatforms(publicFailure);
    messages.push(`${platforms.join("、") || "公共"} API 获取失败`);
  }
  const privateFailure = note.match(/([^。]*本次私有同步失败)/)?.[1];
  if (privateFailure) messages.push(privateFailure.replace("本次私有同步失败", "账户 API 同步失败"));
  const partialFailure = note.match(/(Bitget 部分数据未返回(?:（[^）]*）)?)/)?.[1];
  if (partialFailure) messages.push(partialFailure);
  const fallbackTime = note.match(/未成功更新的项目沿用 ([^。]+?) 的最近一次成功数据/)?.[1];
  if (fallbackTime) messages.push(`沿用 ${fallbackTime} 缓存`);
  return messages.length ? `${messages.join("；")}。` : "";
}

export function safeDiagnostic(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const responseCode = message.match(/\(([a-z0-9_\/;-]+)\)/i)?.[0];
  if (responseCode) return responseCode.slice(1, -1);
  if (error instanceof Error && error.name === "AbortError") return "timeout";
  return "unknown";
}

export function safeCacheError(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") return "请求超时";
  return error instanceof Error ? error.message.slice(0, 180) : "未知错误";
}

export function buildFailures(status: PrivateStatuses, diagnostics: PrivateDiagnostics, publicFailures: string[], publicPartials: string[] = []) {
  const failed = ([
    ["binanceGlobal", "Binance Global"],
    ["binanceBahrain", "Binance Bahrain"],
    ["bybitGlobal", "Bybit Global"],
    ["bitget", "Bitget"],
    ["okx", "OKX"],
  ] as const).flatMap(([key, label]) => status[key] === "error"
    ? [privateFailureLabel(key, label, diagnostics[key])]
    : []);
  const partialFailure = [
    ...(status.binanceGlobal === "partial" ? scopedBinanceFailures("Binance Global", diagnostics.binanceGlobal) : []),
    ...(status.binanceBahrain === "partial" ? scopedBinanceFailures("Binance Bahrain", diagnostics.binanceBahrain) : []),
    ...(status.bybitGlobal === "partial" ? scopedBybitFailures(diagnostics.bybitGlobal) : []),
    ...(status.bitget === "partial" ? scopedBitgetFailures(diagnostics.bitget) : []),
  ];
  const publicPlatforms = summarizePublicFailures(publicFailures);
  const partialPublicPlatforms = summarizePublicFailures(publicPartials).map((platform) => `${platform}（部分数据未返回）`);
  return [...failed, ...partialFailure, ...partialPublicPlatforms, ...publicPlatforms.filter((platform) => (
    !failed.some((failure) => platform.startsWith(failure.replace(/（.*$/, "")))
    && !partialFailure.some((failure) => platform.startsWith(failure.replace(/（.*$/, "")))
    && !partialPublicPlatforms.some((failure) => platform.startsWith(failure.replace(/（.*$/, "")))
  ))];
}

export function buildNote(failures: string[]) {
  if (failures.length === 0) return "";
  const incomplete = failures.filter((failure) => failure.includes("未返回") || failure.includes("未完整返回"));
  const actualFailures = failures.filter((failure) => !failure.includes("未返回") && !failure.includes("未完整返回"));
  if (failures.some((failure) => failure === "公开交易所" || failure.includes("数据更新失败"))) {
    return "本次产品和持仓数据更新失败";
  }
  const incompleteText = incomplete.map((failure) => sanitizeSyncFailure(failure)).join("、");
  const actualTargets = [...new Set(actualFailures.map((failure) => failure.replace(/（.*$/, "").trim()).filter(Boolean))];
  const actualText = actualFailures.length
    ? (actualTargets.map((target) => `${target} API 暂不可用`).join("、") || "交易所 API 暂不可用")
    : "";
  return [
    incompleteText,
    actualText,
  ].filter(Boolean).length
    ? `${[incompleteText, actualText].filter(Boolean).join("；")}`
    : "";
}

export function legacyFailures(note: string) {
  const messages: string[] = [];
  const privateFailure = note.match(/([^。]*)(?:本次私有同步失败|账户 API 同步失败)/)?.[1];
  if (privateFailure) messages.push(privateFailure.trim().replace(/[、，]$/, ""));
  const partialFailure = note.match(/Bitget 部分数据未返回(?:（([^）]*)）)?/)?.[1];
  if (partialFailure !== undefined) messages.push(`Bitget（${partialFailure || "部分数据未返回"}）`);
  const publicFailure = note.match(/([^。]*公共 (?:APR|API)[^。]*失败)/)?.[1];
  if (publicFailure) {
    const existing = messages.join("、");
    messages.push(...extractPlatforms(publicFailure).filter((platform) => !existing.includes(platform)));
  }
  return messages.length
    ? messages.map(normalizePlatformLabel)
    : extractPlatforms(note.match(/([^。]*失败[^。]*)/)?.[1] ?? "");
}

function normalizePlatformLabel(value: string) {
  return value
    .replace(/^Binance\.com(?=\s|（|$)/, "Binance Global")
    .replace(/^Bybit\.com(?=\s|（|$)/, "Bybit Global");
}

function extractPlatforms(text: string) {
  const knownPlatforms = [
    ["Binance.com", "Binance Global"],
    ["Binance Global", "Binance Global"],
    ["Binance Bahrain", "Binance Bahrain"],
    ["Bybit.com", "Bybit Global"],
    ["Bybit Global", "Bybit Global"],
    ["Bybit EU", "Bybit EU"],
    ["Bitget", "Bitget"],
    ["OKX", "OKX"],
    ["MEXC", "MEXC"],
  ] as const;
  return [...new Set(knownPlatforms.filter(([alias]) => text.includes(alias)).map(([, label]) => normalizePlatformLabel(label)))];
}

function privateFailureLabel(key: keyof PrivateStatuses, label: string, diagnostic?: string) {
  if (key === "bybitGlobal" && diagnostic?.startsWith("scopes:")) {
    const scopes = scopedBybitFailures(diagnostic);
    return scopes.length ? scopes.join("、") : label;
  }
  if ((key === "binanceGlobal" || key === "binanceBahrain") && diagnostic?.startsWith("scopes:")) {
    const scopes = scopedBinanceFailures(label, diagnostic);
    return scopes.length ? scopes.join("、") : label;
  }
  if (key === "bitget" && diagnostic?.startsWith("scopes:")) {
    const scopes = scopedBitgetFailures(diagnostic);
    return scopes.length ? scopes.join("、") : label;
  }
  if (key === "bitget" && diagnostic?.includes("public_blocked")) {
    return `${label}（账户与公开接口均访问失败，原因待检查）`;
  }
  if (key === "bitget" && diagnostic?.includes("public_ok")) {
    return `${label}（账户接口读取失败，公开接口可访问）`;
  }
  if (diagnostic === "timeout") return `${label}（请求超时）`;
  if (!diagnostic || diagnostic === "unknown") return `${label}（连接失败，原因待检查）`;
  return `${label}（接口返回 ${diagnostic}）`;
}

function scopedBybitFailures(diagnostic?: string) {
  const scopes = diagnostic?.startsWith("scopes:")
    ? diagnostic.slice("scopes:".length).split("|").filter(Boolean)
    : [];
  if (scopes.length === 0) return ["Bybit Global"];
  return scopes.map((scope) => {
    const flexibleFailure = scope.match(/^活期持仓请求失败:(.+)$/);
    if (flexibleFailure) return `Bybit Global 活期持仓 ${flexibleFailure[1]}`;
    if (scope.startsWith("活期持仓部分返回:")) return "Bybit Global 活期持仓部分数据未返回";
    if (scope.endsWith("请求失败")) return `Bybit Global ${scope.replace("请求失败", "")}`;
    if (scope.endsWith("部分返回")) return `Bybit Global ${scope.replace("部分返回", "部分数据未返回")}`;
    if (["定期产品", "定期持仓"].includes(scope)) return `Bybit Global ${scope}`;
    return `Bybit Global ${scope}`;
  });
}

function scopedBinanceFailures(label: string, diagnostic?: string) {
  const scopes = diagnostic?.startsWith("scopes:")
    ? diagnostic.slice("scopes:".length).split("|").filter(Boolean)
    : [];
  return scopes.length ? scopes.map((scope) => {
    if (scope.endsWith("请求失败")) return `${label} ${scope.replace("请求失败", "API 请求失败")}`;
    if (scope.endsWith("部分返回")) return `${label} ${scope.replace("部分返回", "部分数据未返回")}`;
    return `${label} ${scope}`;
  }) : [`${label} 部分数据未返回`];
}

function scopedBitgetFailures(diagnostic?: string) {
  const scopes = diagnostic?.startsWith("scopes:")
    ? diagnostic.slice("scopes:".length).split("|").filter(Boolean)
    : [];
  return scopes.length ? scopes.map((scope) => {
    if (scope.endsWith("请求失败")) return `Bitget ${scope.replace("请求失败", "")}`;
    if (scope.endsWith("部分返回")) return `Bitget ${scope.replace("部分返回", "部分数据未返回")}`;
    return `Bitget ${scope}`;
  }) : [diagnostic || "Bitget 部分数据未返回"];
}

export function productHoldingSyncState(product: Product, statuses: PrivateStatuses): HoldingSyncState | null {
  if (product.holdingDataMode !== "api") return null;
  const statusByAccountId: Record<string, PrivateStatus> = {
    "binance-global": statuses.binanceGlobal,
    "binance-bahrain": statuses.binanceBahrain,
    "bybit-global": statuses.bybitGlobal,
    "bitget-global": statuses.bitget,
    "okx-global": statuses.okx,
  };
  return statusByAccountId[product.accountId] ?? "not_configured";
}
