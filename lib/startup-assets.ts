// This declaration order is also the exact-path tie-break priority: app-specific
// chunks stay identifiable when the bundler assigns one physical chunk to
// multiple logical roles; broad runtime roles are fallbacks.
export const STARTUP_SCRIPT_LABELS = {
  dashboard: "仪表盘脚本",
  "private-dashboard-client": "私人页外框脚本",
  "startup-diagnostics": "共享启动脚本（含诊断）",
  "layout-segment-context": "页面上下文脚本",
  index: "启动入口脚本",
  "rolldown-runtime": "模块加载运行时",
  framework: "框架脚本",
  vinext: "页面运行时脚本",
} as const;

export type StartupScriptRole = keyof typeof STARTUP_SCRIPT_LABELS;
export type StartupAssetManifest = {
  version: 1;
  scripts: Partial<Record<StartupScriptRole, string[]>>;
  dashboardPreloads: string[];
};

export const EMPTY_STARTUP_ASSET_MANIFEST: StartupAssetManifest = {
  version: 1,
  scripts: {},
  dashboardPreloads: [],
};

/** Convert a manifest asset reference to a pathname for exact timing lookup. */
export function startupAssetPathname(asset: string): string | undefined {
  try {
    return new URL(asset, "https://startup-assets.invalid").pathname;
  } catch {
    return undefined;
  }
}

/** Match only exact manifest paths; never infer a script role from its filename. */
export function startupScriptRoleForPath(pathname: string, manifest?: StartupAssetManifest): StartupScriptRole | undefined {
  if (!manifest || manifest.version !== 1) return undefined;
  for (const role of Object.keys(STARTUP_SCRIPT_LABELS) as StartupScriptRole[]) {
    if (manifest.scripts[role]?.some((asset) => startupAssetPathname(asset) === pathname)) return role;
  }
  return undefined;
}

/** Keep manifest references usable as link hrefs without exposing them in diagnostics. */
export function startupAssetHref(asset: string): string {
  if (asset.startsWith("/") || asset.startsWith("http://") || asset.startsWith("https://")) return asset;
  return `/${asset}`;
}
