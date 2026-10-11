"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { DashboardModuleFailure, DashboardModuleSkeleton } from "@/app/components/dashboard/dashboard-skeleton";
import type { Asset } from "@/lib/domain";
import { reportStartupDiagnostic, StartupDiagnostics } from "@/app/components/startup-diagnostics";

function assetFromLocation(): Asset | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("asset")?.toUpperCase();
  return value === "USDT" || value === "USDC" || value === "USDGO" || value === "BTC" ? value : "USDT";
}

const PrivateDashboard = dynamic(
  () => import("@/app/components/dashboard/dashboard").then((module) => {
    reportStartupDiagnostic("dashboard-module", "私人页面模块", "已加载");
    return module.Dashboard;
  }),
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
