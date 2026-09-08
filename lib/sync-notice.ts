import { SYNC_ATTEMPT_WINDOW_MS } from "./sync-cache";

export const serverReadFailureMessage = "服务器读取失败，数据无法显示，请刷新页面。";

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

export function syncFailureSummary(failures: string[]) {
  if (failures.includes("页面数据读取失败")) return serverReadFailureMessage;
  if (failures.some((value) => value === "公开交易所" || value.includes("数据更新失败"))) {
    return "本次产品和持仓数据更新失败；下次更新将重试。";
  }
  const targets = [...new Set(failures.map(failureTarget).filter(Boolean))];
  return `${targets.length ? targets.join("、") : "交易所"} API 暂不可用；下次更新将重试。`;
}

function failureTarget(value: string) {
  const platform = ["Binance.com", "Binance Bahrain", "Bybit.com", "Bybit EU", "Bitget", "OKX", "MEXC"]
    .find((candidate) => value.startsWith(candidate));
  if (!platform) return value.replace(/（.*$/, "").trim();
  const scope = value.slice(platform.length);
  const assets = ["USDT", "USDC", "USDGO", "BTC"].filter((asset) => scope.includes(asset));
  const area = ["定期产品", "定期持仓", "产品接口", "持仓接口"].find((name) => scope.includes(name));
  return [platform, assets.join("/"), area?.replace("接口", "")].filter(Boolean).join(" ");
}

export function nextScheduledRefreshAt(now: number) {
  const local = new Date(now + 8 * 60 * 60 * 1000);
  const hour = local.getUTCHours();
  if (hour >= 7) local.setUTCDate(local.getUTCDate() + 1);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 7 - 8)).toISOString();
}

type RefreshStatus = {
  state: string;
  updatedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
};

/** Bridge the gap between a scheduled slot and the next cache poll. */
export function scheduledRefreshPending(now: number, cache?: RefreshStatus | null) {
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
