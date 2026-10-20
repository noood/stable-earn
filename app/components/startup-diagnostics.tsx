"use client";

import { useEffect, useState } from "react";

type DiagnosticEntry = { key: string; label: string; value: string };
const eventName = "stable-earn:startup-diagnostic";
const entries = new Map<string, DiagnosticEntry>();

export function reportStartupDiagnostic(key: string, label: string, value: string) {
  if (typeof window === "undefined") return;
  const entry = { key, label, value };
  entries.set(key, entry);
  window.dispatchEvent(new CustomEvent<DiagnosticEntry>(eventName, { detail: entry }));
}

export function StartupDiagnostics() {
  const [enabled, setEnabled] = useState(false);
  const [items, setItems] = useState<DiagnosticEntry[]>([]);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("diagnostics") !== "1") return;
    reportStartupDiagnostic("client-shell", "客户端启动", `导航后 ${Math.round(performance.now())}ms`);
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (navigation) {
      reportStartupDiagnostic("document-ready", "HTML 文档", `DOMContentLoaded ${Math.round(navigation.domContentLoadedEventEnd)}ms`);
    }

    const syncEntries = () => setItems([...entries.values()]);
    const handleDiagnostic = () => syncEntries();
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
    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);
    const enableTimer = window.setTimeout(() => {
      setEnabled(true);
      syncEntries();
    }, 0);
    return () => {
      window.clearTimeout(enableTimer);
      window.removeEventListener(eventName, handleDiagnostic);
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, []);

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
        <p className="mt-2 text-secondary">接口耗时分为浏览器总耗时和服务端处理耗时；不会显示账户数据、请求内容、Cookie 或密钥。</p>
      </section>
    </aside>
  );
}
