"use client";

import { useEffect, useState } from "react";
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

type DashboardComponent = typeof import("@/app/components/dashboard/dashboard").Dashboard;

export default function PrivateDashboardClient() {
  const [LoadedDashboard, setLoadedDashboard] = useState<DashboardComponent | null>(null);
  const [moduleError, setModuleError] = useState(false);
  const [shellAsset, setShellAsset] = useState<Asset | null>(null);

  useEffect(() => {
    let active = true;
    const shellTimer = window.setTimeout(() => setShellAsset(assetFromLocation()), 0);
    const simulateFailure = process.env.NODE_ENV === "development"
      && new URLSearchParams(window.location.search).get("moduleScenario") === "error";
    // This shell already owns loading/error UI. Resolving an explicit import
    // avoids a Suspense fallback retry delaying the dashboard's first commit.
    const startedAt = performance.now();
    let failureTimer: number | undefined;
    if (simulateFailure) {
      failureTimer = window.setTimeout(() => setModuleError(true), 1_000);
    } else {
      reportStartupDiagnostic("dashboard-import", "页面模块开始加载", `导航后 ${Math.round(startedAt)}ms`, startedAt);
      void import("@/app/components/dashboard/dashboard").then((module) => {
        if (!active) return;
        const now = performance.now();
        reportStartupDiagnostic("dashboard-module", "私人页面模块", `加载 ${Math.round(now - startedAt)}ms · 导航后 ${Math.round(now)}ms`, now);
        setLoadedDashboard(() => module.Dashboard);
      }).catch(() => {
        if (active) setModuleError(true);
      });
    }
    return () => {
      active = false;
      window.clearTimeout(shellTimer);
      window.clearTimeout(failureTimer);
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
    {moduleError
      ? <DashboardModuleFailure asset={shellAsset} onAssetChange={changeShellAsset} />
      : LoadedDashboard
        ? <LoadedDashboard mode="private" localPreview={process.env.NODE_ENV === "development"} />
        : <DashboardModuleSkeleton asset={shellAsset} onAssetChange={changeShellAsset} />}
  </>;
}
