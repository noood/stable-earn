"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { DashboardModuleFailure, DashboardModuleSkeleton } from "@/app/components/dashboard/dashboard-skeleton";
import type { Asset } from "@/lib/domain";
import { reportStartupDiagnostic, StartupDiagnostics } from "@/app/components/startup-diagnostics";

const clientShellLoadedAt = typeof performance === "undefined" ? 0 : performance.now();
reportStartupDiagnostic("client-module", "客户端模块执行", `导航后 ${Math.round(clientShellLoadedAt)}ms`, clientShellLoadedAt);

function assetFromLocation(): Asset | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("asset")?.toUpperCase();
  return value === "USDT" || value === "USDC" || value === "USDGO" || value === "BTC" ? value : "USDT";
}

const PrivateDashboard = dynamic(
  () => {
    const startedAt = performance.now();
    reportStartupDiagnostic("dashboard-import", "页面模块开始加载", `导航后 ${Math.round(startedAt)}ms`, startedAt);
    return import("@/app/components/dashboard/dashboard").then((module) => {
      const now = performance.now();
      reportStartupDiagnostic("dashboard-module", "私人页面模块", `加载 ${Math.round(now - startedAt)}ms · 导航后 ${Math.round(now)}ms`, now);
      return module.Dashboard;
    });
  },
  {
    ssr: false,
    loading: ({ error }) => error
      ? <DashboardModuleFailure asset={assetFromLocation()} />
      : <DashboardModuleSkeleton asset={assetFromLocation()} />,
  },
);

export default function PrivateDashboardClient() {
  const [modulePreview, setModulePreview] = useState<"checking" | "normal" | "error">("checking");
  const [shellAsset, setShellAsset] = useState<Asset | null>(null);

  useEffect(() => {
    const shellTimer = window.setTimeout(() => setShellAsset(assetFromLocation()), 0);
    const simulateFailure = process.env.NODE_ENV === "development"
      && new URLSearchParams(window.location.search).get("moduleScenario") === "error";
    // Keep the initial shell visible long enough to inspect before a simulated failure.
    const timer = window.setTimeout(() => {
      setModulePreview(simulateFailure ? "error" : "normal");
    }, simulateFailure ? 1_000 : 0);
    return () => {
      window.clearTimeout(shellTimer);
      window.clearTimeout(timer);
    };
  }, []);

  function changeShellAsset(nextAsset: Asset) {
    setShellAsset(nextAsset);
    const url = new URL(window.location.href);
    if (nextAsset === "USDT") url.searchParams.delete("asset");
    else url.searchParams.set("asset", nextAsset);
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }

  return <>
    <StartupDiagnostics />
    {modulePreview === "checking"
      ? <DashboardModuleSkeleton asset={shellAsset} onAssetChange={changeShellAsset} />
      : modulePreview === "error"
        ? <DashboardModuleFailure asset={shellAsset} onAssetChange={changeShellAsset} />
        : <PrivateDashboard mode="private" localPreview={process.env.NODE_ENV === "development"} />}
  </>;
}
