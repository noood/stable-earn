type ResourceTiming = Pick<PerformanceResourceTiming, "name" | "startTime" | "requestStart" | "responseStart" | "responseEnd" | "transferSize" | "encodedBodySize">;
export type BrowserTimingLine = { key: string; label: string; value: string };

const scriptLabels: Record<string, string> = {
  framework: "框架脚本",
  vinext: "页面运行时脚本",
  index: "启动入口脚本",
  "private-dashboard-client": "私人页外框脚本",
  "startup-diagnostics": "共享启动脚本（含诊断）",
  dashboard: "仪表盘脚本",
  "rolldown-runtime": "模块加载运行时",
  "layout-segment-context": "页面上下文脚本",
};

/** Export fixed labels and numbers, never resource URLs, query strings or API paths. */
export function summarizeStartupResources(resources: ResourceTiming[], origin: string, until: number): BrowserTimingLine[] {
  const selected = new Map<string, { entry: ResourceTiming; label: string }>();
  for (const entry of resources) {
    let url: URL;
    try { url = new URL(entry.name); } catch { continue; }
    if (url.origin !== origin || !url.pathname.startsWith("/_next/static/") || entry.responseEnd <= 0 || entry.responseEnd > until) continue;
    const file = url.pathname.split("/").pop() ?? "";
    const group = file.endsWith(".css") ? "stylesheet" : Object.keys(scriptLabels).find((name) => file.startsWith(`${name}-`) && file.endsWith(".js"));
    if (!group) continue;
    const previous = selected.get(group);
    if (!previous || previous.entry.responseEnd < entry.responseEnd) selected.set(group, { entry, label: group === "stylesheet" ? "页面样式" : scriptLabels[group] });
  }
  return [...selected].sort((a, b) => a[1].entry.startTime - b[1].entry.startTime).map(([key, { entry, label }]) => ({
    key: `resource-${key}`,
    label,
    value: `导航后 ${Math.round(entry.startTime)}→${Math.round(entry.responseEnd)}ms · ${entry.responseStart > 0 && entry.requestStart > 0 ? `首字节等待 ${Math.max(0, Math.round(entry.responseStart - entry.requestStart))}ms · 下载 ${Math.max(0, Math.round(entry.responseEnd - entry.responseStart))}ms · ` : ""}传输 ${Math.round(entry.transferSize / 102.4) / 10}KB · 压缩正文 ${Math.round(entry.encodedBodySize / 102.4) / 10}KB${entry.transferSize === 0 ? "（零传输不单独证明缓存命中）" : ""}`,
  }));
}

export function summarizeStartupLongTasks(tasks: Array<{ startTime: number; duration: number }>, until: number): string {
  const relevant = tasks.filter((task) => task.startTime < until && Number.isFinite(task.startTime) && Number.isFinite(task.duration) && task.duration >= 50);
  const intervals = relevant.map((task) => ({ start: task.startTime, end: Math.min(until, task.startTime + task.duration), full: task.duration }));
  const total = intervals.reduce((sum, task) => sum + task.end - task.start, 0);
  const slowest = [...intervals].sort((a, b) => b.full - a.full).slice(0, 5);
  return `截至导航后 ${Math.round(until)}ms · ${relevant.length}个 ≥50ms 长任务 · 窗口内合计 ${Math.round(total)}ms${slowest.length ? ` · 最长任务：${slowest.map((task) => `${Math.round(task.start)}→${Math.round(task.end)}ms`).join("，")}` : ""}`;
}
