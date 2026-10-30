"use client";

import { useEffect, useState } from "react";
import type { StartupAssetManifest } from "@/lib/startup-assets";
import { summarizeStartupLongTasks, summarizeStartupResources } from "@/lib/startup-resource-timing";

type DiagnosticEntry = { key: string; label: string; value: string; at: number };
const eventName = "stable-earn:startup-diagnostic";
const entries = new Map<string, DiagnosticEntry>();
const initialVisibility = typeof document === "undefined" ? "unknown" : document.visibilityState;

export function startupDiagnosticsEnabled() {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("diagnostics") === "1";
}

export function publishStartupDiagnostics() {
  if (startupDiagnosticsEnabled()) window.dispatchEvent(new CustomEvent(eventName));
}

export function reportStartupDiagnostic(key: string, label: string, value: string, at = performance.now(), notify = true) {
  if (!startupDiagnosticsEnabled()) return;
  const entry = { key, label, value, at };
  entries.set(key, entry);
  if (notify) publishStartupDiagnostics();
}

export function startupDiagnosticTime(key: string) {
  return entries.get(key)?.at;
}

export function StartupDiagnostics({ assetManifest }: { assetManifest?: StartupAssetManifest }) {
  const [enabled, setEnabled] = useState(false);
  const [items, setItems] = useState<DiagnosticEntry[]>([]);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("diagnostics") !== "1") return;
    reportStartupDiagnostic("client-shell", "客户端挂载", `导航后 ${Math.round(performance.now())}ms`);
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    let hiddenDuringStartup = initialVisibility === "hidden" || document.hidden;
    const reportVisibility = () => {
      if (entries.has("opening-complete")) return;
      hiddenDuringStartup ||= document.hidden;
      reportStartupDiagnostic("measurement-context", "采样条件", `导航 ${navigation?.type ?? "未知"} · 初始 ${initialVisibility} · 启动期间曾在后台：${hiddenDuringStartup ? "是" : "否"}`);
    };
    reportVisibility();
    if (navigation) {
      reportStartupDiagnostic("document-response", "HTML 请求与下载", `请求 ${Math.round(navigation.requestStart)}ms · 首字节 ${Math.round(navigation.responseStart)}ms · 下载结束 ${Math.round(navigation.responseEnd)}ms（均从导航开始）`);
      reportStartupDiagnostic("document-ready", "HTML 文档", `DOMContentLoaded ${Math.round(navigation.domContentLoadedEventEnd)}ms`);
    }

    const syncEntries = () => setItems([...entries.values()]);
    const longTasks: Array<{ startTime: number; duration: number }> = [];
    let observer: PerformanceObserver | undefined;
    let longTasksSupported = false;
    let finishTimer: number | undefined;
    let captured = false;
    try {
      if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
        observer = new PerformanceObserver((list) => { longTasks.push(...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration }))); });
        observer.observe({ type: "longtask", buffered: true });
        longTasksSupported = true;
      }
    } catch { observer?.disconnect(); }
    const captureResources = (until: number) => {
      try {
        const lines = summarizeStartupResources(performance.getEntriesByType("resource") as PerformanceResourceTiming[], window.location.origin, until, assetManifest);
        for (const line of lines) reportStartupDiagnostic(line.key, line.label, line.value, until, false);
        reportStartupDiagnostic("resource-coverage", "资源计时范围", lines.length ? "仅同源关键脚本/样式；请求区间不等于 JS 执行时间" : "尚无已完成的关键脚本/样式记录", until, false);
      } catch {
        reportStartupDiagnostic("resource-coverage", "资源计时范围", "浏览器未提供可用资源计时", until, false);
      }
    };
    const handleDiagnostic = () => {
      syncEntries();
      const openingEnd = entries.get("opening-complete")?.at;
      if (openingEnd === undefined || captured || finishTimer !== undefined) return;
      // Observe after the opening task has finished. This never delays the
      // data/notice checkpoints or forces passive effects from a layout effect.
      finishTimer = window.setTimeout(() => {
        captured = true;
        longTasks.push(...(observer?.takeRecords() ?? []).map(({ startTime, duration }) => ({ startTime, duration })));
        observer?.disconnect();
        captureResources(openingEnd);
        reportStartupDiagnostic("startup-longtasks", "启动主线程长任务", longTasksSupported ? summarizeStartupLongTasks(longTasks, openingEnd) : "当前浏览器不支持 Long Tasks API，不能据此判断没有阻塞", openingEnd, false);
        syncEntries();
      }, 0);
    };
    const handleError = (event: ErrorEvent) => {
      const errorName = event.error instanceof Error ? event.error.name.slice(0, 32) : "未知错误";
      reportStartupDiagnostic("script-error", "页面脚本错误", errorName);
    };
    const handleRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const errorName = reason instanceof Error ? reason.name.slice(0, 32) : "请求或脚本失败";
      reportStartupDiagnostic("async-error", "异步错误", errorName);
    };

    window.addEventListener(eventName, handleDiagnostic);
    document.addEventListener("visibilitychange", reportVisibility);
    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);
    const enableTimer = window.setTimeout(() => {
      setEnabled(true);
      captureResources(performance.now());
      handleDiagnostic();
    }, 0);
    return () => {
      window.clearTimeout(enableTimer);
      window.clearTimeout(finishTimer);
      observer?.disconnect();
      window.removeEventListener(eventName, handleDiagnostic);
      document.removeEventListener("visibilitychange", reportVisibility);
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, [assetManifest]);

  if (!enabled) return null;

  return (
    <aside className="fixed inset-x-3 bottom-3 z-[1000] mx-auto max-w-xl" aria-label="页面启动诊断">
      <section className="card max-h-[40vh] overflow-y-auto p-3 text-xs shadow-lg" role="status" aria-live="polite">
        <p className="mb-2 font-semibold">页面诊断（启动阶段与耗时）</p>
        <ul className="grid gap-1">
          {items.map((item) => (
            <li key={item.key} className="flex justify-between gap-3">
              <span className="shrink-0 text-secondary">{item.label}</span>
              <span className="min-w-0 break-words text-right">{item.value}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-secondary">骨架屏移除记录 DOM 提交，首次打开流程结束还包含每日刷新检查。请求区间从导航开始；服务端分段从接口开始，可能重叠。仅显示计时和状态，不显示账户数据或密钥。</p>
      </section>
    </aside>
  );
}
