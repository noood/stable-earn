"use client";

import { useEffect, useState } from "react";
import { DashboardModuleFailure, DashboardModuleSkeleton } from "@/app/components/dashboard/dashboard-skeleton";
import type { Asset } from "@/lib/domain";
import { reportStartupDiagnostic, StartupDiagnostics } from "@/app/components/startup-diagnostics";
import { DashboardModulePreload } from "./dashboard-module-preload";

const clientShellLoadedAt = typeof performance === "undefined" ? 0 : performance.now();
reportStartupDiagnostic("client-module", "客户端模块执行", `导航后 ${Math.round(clientShellLoadedAt)}ms`, clientShellLoadedAt);

function assetFromLocation(): Asset | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("asset")?.toUpperCase();
  return value === "USDT" || value === "USDC" || value === "USDGO" || value === "BTC" ? value : "USDT";
}

type DashboardComponent = typeof import("@/app/components/dashboard/dashboard").Dashboard;
type DashboardLoadResult = { component: DashboardComponent } | { failed: true };

const simulateModuleFailure = typeof window !== "undefined"
  && process.env.NODE_ENV === "development"
  && new URLSearchParams(window.location.search).get("moduleScenario") === "error";

// Start downloading as soon as the browser evaluates the lightweight shell,
// rather than waiting for React's passive effects. Never load the heavy module
// during SSR, and keep the local failure preview independent of that module.
const dashboardLoad: Promise<DashboardLoadResult> | null = typeof window === "undefined" || simulateModuleFailure
  ? null
  : (() => {
    const startedAt = performance.now();
    reportStartupDiagnostic("dashboard-import", "页面模块开始加载", `导航后 ${Math.round(startedAt)}ms`, startedAt);
    // Keep the rejection handler outside the import expression: the production
    // bundler can wrap import() in a dependency-preload Promise that also fails.
    const loading = import("@/app/components/dashboard/dashboard");
    return loading.then((module): DashboardLoadResult => {
      const now = performance.now();
      reportStartupDiagnostic("dashboard-module", "私人页面模块", `加载 ${Math.round(now - startedAt)}ms · 导航后 ${Math.round(now)}ms`, now);
      return { component: module.Dashboard };
    }).catch((): DashboardLoadResult => ({ failed: true }));
  })();

export default function PrivateDashboardClient() {
  const [LoadedDashboard, setLoadedDashboard] = useState<DashboardComponent | null>(null);
  const [moduleError, setModuleError] = useState(false);
  const [shellAsset, setShellAsset] = useState<Asset | null>(null);

  useEffect(() => {
    let active = true;
    const shellTimer = window.setTimeout(() => setShellAsset(assetFromLocation()), 0);
    // This shell already owns loading/error UI. Resolving an explicit import
    // avoids a Suspense fallback retry delaying the dashboard's first commit.
    let failureTimer: number | undefined;
    if (simulateModuleFailure) {
      failureTimer = window.setTimeout(() => setModuleError(true), 1_000);
    } else if (dashboardLoad) {
      void dashboardLoad.then((result) => {
        if (!active) return;
        if ("failed" in result) setModuleError(true);
        else setLoadedDashboard(() => result.component);
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
    <DashboardModulePreload />
    <StartupDiagnostics />
    {moduleError
      ? <DashboardModuleFailure asset={shellAsset} onAssetChange={changeShellAsset} />
      : LoadedDashboard
        ? <LoadedDashboard mode="private" localPreview={process.env.NODE_ENV === "development"} />
        : <DashboardModuleSkeleton asset={shellAsset} onAssetChange={changeShellAsset} />}
  </>;
}
