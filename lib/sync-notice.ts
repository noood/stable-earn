export function syncFailureSummary(failures: string[]) {
  if (failures.includes("页面数据读取失败")) return "页面数据读取失败，请检查网络后重试；已有数据保持不变。";
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
  const targetHour = hour < 6 ? 6 : hour < 18 ? 18 : 6;
  if (hour >= 18) local.setUTCDate(local.getUTCDate() + 1);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), targetHour - 8)).toISOString();
}
