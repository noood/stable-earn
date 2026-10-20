"use client";

import { getPagesClientAssets } from "vinext/server/pages-client-assets";

// The client boundary deliberately reads the manifest in the SSR environment,
// where Vinext initializes its public asset registry. It only emits download
// hints: Dashboard remains client-loaded and account reads still wait for mount.
export function DashboardModulePreload() {
  if (typeof window !== "undefined") return null;
  const assets = getPagesClientAssets();
  const files = assets.dynamicPreloads?.["app/components/dashboard/dashboard.tsx"] ?? [];
  const scripts = [...new Set(files.filter((file) => file.endsWith(".js")))];
  if (scripts.length === 0) return null;
  return <>{scripts.map((file) => <link
    key={file}
    rel="modulepreload"
    href={file.startsWith("/") || file.startsWith("http://") || file.startsWith("https://") ? file : `/${file}`}
    as="script"
    crossOrigin={assets.crossOrigin ?? ""}
    fetchPriority="low"
  />)}</>;
}
