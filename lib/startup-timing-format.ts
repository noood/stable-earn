export const startupTimingPhases = {
  auth: "登录校验",
  auth_keys: "解析登录签名公钥",
  auth_keys_fetch: "公钥网络请求至响应头",
  database: "数据库准备",
  settings: "读取刷新设置",
  lock_read: "检查运行锁",
  lock_acquire: "申请运行锁",
  cache_read: "读取同步缓存",
  snapshot_read: "读取缓存、设置与刷新状态",
  holdings_snapshot: "批量读取个人数据快照",
  daily_check: "检查当日记录",
  maturities: "检查手动产品到期",
  history: "读取变更记录",
  history_summary: "历史摘要调用总耗时",
  history_recent: "最近历史调用总耗时",
  history_unread: "未读提醒调用总耗时",
  history_merge: "历史合并去重排序",
  lock_release: "释放运行锁",
  sync: "执行同步流程",
} as const;

export const startupTimingMetrics = {
  auth_keys_cached: { label: "解析前公钥缓存有效", unit: "（1是/0否）" },
  auth_keys_loading: { label: "解析前公钥请求进行中", unit: "（1是/0否）" },
  history_summary_sql: { label: "历史摘要 SQL 执行（末次尝试）", unit: "ms" },
  history_summary_d1: { label: "历史摘要 D1 duration", unit: "ms" },
  history_summary_rows: { label: "历史摘要返回", unit: "条" },
  history_summary_read: { label: "历史摘要扫描", unit: "行" },
  history_summary_attempts: { label: "历史摘要执行尝试", unit: "次" },
  history_recent_sql: { label: "最近历史 SQL 执行（末次尝试）", unit: "ms" },
  history_unread_sql: { label: "未读提醒 SQL 执行（末次尝试）", unit: "ms" },
  history_recent_d1: { label: "最近历史 D1 duration", unit: "ms" },
  history_unread_d1: { label: "未读提醒 D1 duration", unit: "ms" },
  history_recent_rows: { label: "最近历史返回", unit: "条" },
  history_unread_rows: { label: "未读提醒返回", unit: "条" },
  history_recent_read: { label: "最近历史扫描", unit: "行" },
  history_unread_read: { label: "未读提醒扫描", unit: "行" },
  history_recent_attempts: { label: "最近历史执行尝试", unit: "次" },
  history_unread_attempts: { label: "未读提醒执行尝试", unit: "次" },
} as const;

export type StartupTimingMetric = keyof typeof startupTimingMetrics;

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
  const recordedMetrics = new Set<string>();
  const details = (header ?? "").split(",").flatMap((part) => {
    const match = part.trim().match(/^(\w+);desc="value=(\d+(?:\.\d+)?)"$/);
    if (!match || !Object.hasOwn(startupTimingMetrics, match[1])) return [];
    const metric = startupTimingMetrics[match[1] as StartupTimingMetric];
    recordedMetrics.add(match[1]);
    return [`${metric.label} ${Number(match[2])}${metric.unit}`];
  });
  for (const [phase, label] of [["history_recent", "最近历史"], ["history_unread", "未读提醒"], ["history_summary", "历史摘要"]]) {
    if (metrics.some((metric) => metric.name === phase) && !recordedMetrics.has(`${phase}_sql`)) {
      details.push(`${label}：D1 未提供独立 SQL 耗时`);
    }
    if (metrics.some((metric) => metric.name === phase) && !recordedMetrics.has(`${phase}_attempts`)) {
      details.push(`${label}：D1 未提供执行尝试次数`);
    }
  }
  return `${browser}${total ? ` · 服务端 ${total.duration}ms` : ""}${phases.length ? ` · 服务端分段：${phases.join("；")}` : ""}${details.length ? ` · 同次请求明细：${details.join("；")}` : ""}`;
}
