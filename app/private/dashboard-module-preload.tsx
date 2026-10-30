"use client";

import { getPagesClientAssets } from "vinext/server/pages-client-assets";
import type { StartupAssetManifest } from "@/lib/startup-assets";
import { startupAssetHref, startupAssetPathname } from "@/lib/startup-assets";

// The server page passes this build's asset map through the static shell.
// Emit download hints during SSR; Dashboard and account reads remain client-loaded.
export function DashboardModulePreload({ assetManifest }: { assetManifest?: StartupAssetManifest }) {
  if (typeof window !== "undefined") return null;
  // This public Vinext API is used only for its configured crossorigin value.
  const assets = getPagesClientAssets();
  const files = assetManifest?.dashboardPreloads ?? [];
  const scripts = [...new Set(files.filter((file) => startupAssetPathname(file)?.endsWith(".js")))];
  if (scripts.length === 0) return null;
  return <>{scripts.map((file) => <link
    key={file}
    rel="modulepreload"
    href={startupAssetHref(file)}
    as="script"
    crossOrigin={assets.crossOrigin ?? ""}
    fetchPriority="low"
  />)}</>;
}
