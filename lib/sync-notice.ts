import { nextScheduledRefreshAt, SYNC_ATTEMPT_WINDOW_MS, type ScheduledRefreshState } from "./sync-cache";

export { nextScheduledRefreshAt } from "./sync-cache";

export const serverReadFailureMessage = "服务器读取失败，数据无法显示，请刷新页面。";

export function completedDataSummary(
  timestamp: string,
  options: { scheduledRefreshFailed: boolean; scheduledSyncDisabled: boolean; nextRefresh: string | null; hasSyncFailure: boolean },
) {
  if (options.scheduledRefreshFailed || options.hasSyncFailure) return `当前数据截至 ${timestamp}，`;
  if (options.scheduledSyncDisabled) return `当前数据截至 ${timestamp}，每日首次打开自动更新。`;
  return `当前数据截至 ${timestamp}${options.nextRefresh ? `，预计 ${options.nextRefresh} 自动更新` : ""}。`;
}

/**
 * Product IDs are useful in Events while investigating an upstream mismatch,
 * but they are not actionable dashboard copy. Older cached snapshots may still
 * contain the diagnostic form, so sanitize at the display boundary as well as
 * when creating new snapshots.
 */
export function sanitizeSyncFailure(value: string) {
  if (/^Bitget.*(?:USDT|USDC|USDGO):\d{6,}/.test(value)) return "Bitget（部分数据未返回）";
  return value;
}

/** Read failures and exchange failures have different display priorities. */
export function dashboardReadState(input: {
  isDemo: boolean; opening: boolean; requesting: boolean; backgroundUpdating: boolean;
  personalReady: boolean; personalError: boolean; productReady: boolean; productReadFailed: boolean;
  lastUpdated: string | null;
}) {
  const complete = input.personalReady && !input.personalError && input.productReady && !input.productReadFailed;
  const historyAvailable = complete && Boolean(input.lastUpdated);
  // A failed page read cannot establish that a scheduled job is still running.
  const updating = !input.isDemo && (input.opening || input.requesting || (input.productReady && !input.productReadFailed && input.backgroundUpdating));
  const dataBlocked = !input.isDemo && !updating && (input.personalError || input.productReadFailed);
  return { updating, historyAvailable, dataBlocked, initialLoading: updating && !historyAvailable,
    canEdit: input.isDemo || (complete && !updating) };
}

export function syncFailureSummary(failures: string[]): string {
  failures = failures.map((failure) => sanitizeSyncFailure(normalizePlatformLabels(failure)));
  if (failures.includes("页面数据读取失败")) return serverReadFailureMessage;
  const incomplete = failures.filter(isIncompleteFailure);
  const actualFailures = failures.filter((value) => !isIncompleteFailure(value));
  if (failures.some((value) => value === "公开交易所" || value.includes("数据更新失败"))) {
    return "本次产品和持仓数据更新失败";
  }
  const messages = [
    incomplete.length ? incomplete.map(formatIncompleteFailure).join("、") : "",
    actualFailures.length
      ? ([...new Set(actualFailures.map(failureTarget).filter(Boolean))].map((target) => `${target} API 暂不可用`).join("、") || "交易所 API 暂不可用")
      : "",
  ].filter(Boolean);
  return messages.join("，");
}

function normalizePlatformLabels(value: string) {
  return value
    .replace(/^Binance\.com(?=\s|（|$)/, "Binance Global")
    .replace(/^Bybit\.com(?=\s|（|$)/, "Bybit Global");
}

function formatIncompleteFailure(value: string) {
  const bitget = value.match(/^Bitget（(.+)）$/);
  return bitget ? `Bitget ${bitget[1].replace("接口未完整返回", "数据未完整返回")}` : value;
}

function isIncompleteFailure(value: string) {
  return value.includes("未返回") || value.includes("未完整返回");
}

function failureTarget(value: string) {
  const platform = ["Binance Global", "Binance Bahrain", "Bybit Global", "Bybit EU", "Bitget", "OKX", "MEXC"]
    .find((candidate) => value.startsWith(candidate));
  if (!platform) return value.replace(/（.*$/, "").trim();
  const scope = value.slice(platform.length);
  const assets = ["USDT", "USDC", "USDGO", "BTC"].filter((asset) => scope.includes(asset));
  const area = ["定期产品", "定期持仓", "产品接口", "持仓接口"].find((name) => scope.includes(name));
  return [platform, assets.join("/"), area?.replace("接口", "")].filter(Boolean).join(" ");
}

type RefreshStatus = {
  state: string;
  updatedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  scheduledAt?: string | null;
  scheduledState?: ScheduledRefreshState | "disabled";
};

/** Bridge the gap between a scheduled slot and the next cache poll. */
export function scheduledRefreshPending(now: number, cache?: RefreshStatus | null) {
  if (cache?.scheduledState === "disabled") return false;
  const slot = Date.parse(nextScheduledRefreshAt(now)) - 24 * 60 * 60 * 1000;
  const attemptedAt = Date.parse(cache?.lastAttemptAt ?? "");
  if (cache?.state === "syncing" && attemptedAt >= slot) {
    return attemptedAt <= now && now - attemptedAt < SYNC_ATTEMPT_WINDOW_MS;
  }
  // Both full and partial committed results finish this slot. A final total
  // failure leaves updatedAt unchanged, so use its recorded attempt instead.
  if (Date.parse(cache?.updatedAt ?? "") >= slot) return false;
  if (cache?.lastError && attemptedAt >= slot) return false;
  return now - slot < SYNC_ATTEMPT_WINDOW_MS;
}
