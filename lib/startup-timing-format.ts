export const startupTimingPhases = {
  auth: "登录校验",
  database: "数据库准备",
  settings: "读取刷新设置",
  lock_read: "检查运行锁",
  lock_acquire: "申请运行锁",
  cache_read: "读取同步缓存",
  daily_check: "检查当日记录",
  maturities: "检查手动产品到期",
  history: "读取变更记录",
  lock_release: "释放运行锁",
  sync: "执行同步流程",
} as const;

export type StartupTimingPhase = keyof typeof startupTimingPhases;

/** Only fixed timing names and numeric values may reach the diagnostics UI. */
export function formatStartupRequestTiming(header: string | null | undefined, startedAt: number, endedAt: number) {
  const browser = `浏览器 ${Math.round(endedAt - startedAt)}ms · 导航后 ${Math.round(startedAt)}→${Math.round(endedAt)}ms`;
  const metrics = (header ?? "").split(",").flatMap((part) => {
    const match = part.trim().match(/^(\w+);dur=(\d+(?:\.\d+)?)(?:;desc="start=(\d+(?:\.\d+)?)")?$/);
    return match ? [{ name: match[1], duration: Number(match[2]), start: match[3] === undefined ? null : Number(match[3]) }] : [];
  });
  const total = metrics.find((metric) => metric.name === "app");
  const phases = metrics.flatMap((metric) => {
    if (!Object.hasOwn(startupTimingPhases, metric.name)) return [];
    const label = startupTimingPhases[metric.name as StartupTimingPhase];
    return [`${label} ${metric.duration}ms${metric.start === null ? "" : `（接口内 ${metric.start}→${Number((metric.start + metric.duration).toFixed(1))}ms）`}`];
  });
  const other = metrics.find((metric) => metric.name === "other");
  if (other) phases.push(`其余处理 ${other.duration}ms`);
  return `${browser}${total ? ` · 服务端 ${total.duration}ms` : ""}${phases.length ? ` · 服务端分段：${phases.join("；")}` : ""}`;
}
