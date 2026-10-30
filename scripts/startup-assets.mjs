import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { posix, resolve } from "node:path";

/** @typedef {import("../lib/startup-assets").StartupAssetManifest} StartupAssetManifest */
/** @typedef {import("../lib/startup-assets").StartupScriptRole} StartupScriptRole */
/** @typedef {{type: "chunk", fileName: string, moduleIds: string[], facadeModuleId?: string | null, imports?: string[]}} StartupChunk */

export const startupAssetsModule = "virtual:stable-earn/startup-assets";
export const startupAssetsFile = "startup-assets.json";
const resolvedModule = `\0${startupAssetsModule}`;
const serverDataFile = "startup-assets.js";
const dataToken = "__STABLE_EARN_CURRENT_BUILD_STARTUP_ASSETS_V1__";

/** @returns {StartupAssetManifest} */
function emptyManifest() {
  return { version: 1, scripts: {}, dashboardPreloads: [] };
}

/** @param {string} id */
function cleanModuleId(id) {
  return id.replaceAll("\\", "/").split("?")[0];
}

/** Classify source modules, never the generated chunk's name or hash.
 * @param {string} id
 * @param {string} root
 * @returns {StartupScriptRole[]}
 */
function sourceRoles(id, root) {
  const clean = cleanModuleId(id);
  const projectPath = clean.startsWith(`${root}/`) ? clean.slice(root.length + 1) : clean;
  /** @type {StartupScriptRole[]} */
  const roles = [];
  if (projectPath === "app/components/dashboard/dashboard.tsx") roles.push("dashboard");
  if (projectPath === "app/private/private-dashboard-client.tsx") roles.push("private-dashboard-client");
  if (projectPath === "app/components/startup-diagnostics.tsx") roles.push("startup-diagnostics");
  const packagePath = clean.startsWith("node_modules/") ? `/${clean}` : clean;
  if (/\/node_modules\/(?:react|react-dom|react-server-dom-webpack|scheduler)\//.test(packagePath)) roles.push("framework");
  if (/\/node_modules\/vinext\//.test(packagePath)) roles.push("vinext");
  if (packagePath.endsWith("/node_modules/vinext/dist/shims/layout-segment-context.js")) roles.push("layout-segment-context");
  if (clean.replace(/^\0/, "") === "virtual:vinext-app-browser-entry"
    || packagePath.endsWith("/node_modules/vinext/dist/server/app-browser-entry.js")) roles.push("index");
  if (clean === "\0rolldown/runtime.js" || clean.endsWith("/_rolldown/runtime.js")) roles.push("rolldown-runtime");
  return roles;
}

/** @param {string} value */
function requirePublicScriptUrl(value) {
  if (!value || /[\0\r\n<>]/.test(value) || !(value.startsWith("/") || /^https?:\/\//.test(value))) {
    throw new Error("Startup assets require a public HTTP(S) or origin-relative URL");
  }
  const url = new URL(value, "https://startup-assets.invalid");
  if (url.username || url.password || !/\.m?js$/.test(url.pathname)) {
    throw new Error("Startup assets require credential-free public JavaScript URLs");
  }
  return value;
}

/** @param {string} fileName @param {string} [base] */
export function startupAssetUrl(fileName, base = "/") {
  if (!fileName || fileName.startsWith("/") || /[\\\0\r\n?#:]/.test(fileName)
    || fileName.split("/").some((part) => part === ".." || part === ".")) {
    throw new Error("Invalid emitted startup asset filename");
  }
  if (!base || base === "./") throw new Error("Startup assets require a fixed public base URL");
  return requirePublicScriptUrl(`${base.replace(/\/$/, "")}/${fileName}`);
}

/** Build a safe resource map from the public output module/dependency graph.
 * @param {Record<string, StartupChunk | {type: "asset"}>} bundle
 * @param {{root: string, base?: string, assetUrl?: (fileName: string) => string}} options
 * @returns {StartupAssetManifest}
 */
export function createStartupAssetManifest(bundle, { root, base = "/", assetUrl = (fileName) => startupAssetUrl(fileName, base) }) {
  const projectRoot = cleanModuleId(root).replace(/\/$/, "");
  const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
  const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  if (byFile.size !== chunks.length) throw new Error("Duplicate startup output filename");
  /** @type {Map<StartupScriptRole, Set<string>>} */
  const roleFiles = new Map();
  for (const chunk of chunks) {
    for (const id of [...chunk.moduleIds, ...(chunk.facadeModuleId ? [chunk.facadeModuleId] : [])]) {
      for (const role of sourceRoles(id, projectRoot)) {
        if (!roleFiles.has(role)) roleFiles.set(role, new Set());
        roleFiles.get(role).add(chunk.fileName);
      }
    }
  }
  for (const role of ["dashboard", "private-dashboard-client", "startup-diagnostics"]) {
    if (!roleFiles.has(/** @type {StartupScriptRole} */ (role))) throw new Error(`Missing startup source mapping: ${role}`);
  }
  const manifest = emptyManifest();
  for (const [role, files] of [...roleFiles].sort(([a], [b]) => a.localeCompare(b))) {
    manifest.scripts[role] = [...files].sort().map((file) => requirePublicScriptUrl(assetUrl(file)));
  }
  const visited = new Set();
  /** @param {string} file */
  function visit(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const chunk = byFile.get(file);
    if (!chunk) throw new Error("Missing static dependency in startup output graph");
    for (const dependency of chunk.imports ?? []) {
      visit(dependency.startsWith(".") ? posix.join(posix.dirname(file), dependency) : dependency);
    }
    manifest.dashboardPreloads.push(requirePublicScriptUrl(assetUrl(file)));
  }
  for (const file of [...roleFiles.get("dashboard")].sort()) visit(file);
  return manifest;
}

/** Escape only generated data; no application code is rewritten.
 * @param {unknown} value
 */
function scriptJson(value) {
  return JSON.stringify(value).replace(/[<>\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** @param {string} code @param {StartupAssetManifest} manifest */
export function fillStartupAssetToken(code, manifest) {
  const literals = code.match(new RegExp(`(["'\x60])${dataToken}\\1`, "g")) ?? [];
  if (literals.length !== 1 || code.split(dataToken).length !== 2) throw new Error("Expected exactly one current-build startup asset token");
  const result = code.replace(literals[0], () => scriptJson(JSON.stringify(manifest)));
  if (result.includes(dataToken)) throw new Error("Unresolved startup asset token");
  return result;
}

/** @returns {import("vite").Plugin[]} */
export function startupAssetsPlugin() {
  /** @type {import("vite").ResolvedConfig} */
  let config;
  /** @type {StartupAssetManifest | null} */
  let manifest = null;
  /** @type {Map<string, {fileName: string, code: string}>} */
  const pending = new Map();
  let started = false;
  return [
    {
      name: "stable-earn:startup-assets-prepare",
      buildApp: { order: "pre", handler() {
        manifest = null;
        pending.clear();
        started = true;
      } },
    },
    {
      name: "stable-earn:startup-assets",
      configResolved(resolved) { config = resolved; },
      resolveId(id) { if (id === startupAssetsModule || id === resolvedModule) return resolvedModule; },
      load(id) {
        if (id !== resolvedModule) return;
        if (config.command !== "build" || this.environment.mode === "dev") return `export default ${scriptJson(emptyManifest())};`;
        if (this.environment.name === "client") throw new Error("Startup asset data must be imported only by a server module");
        return `export default JSON.parse(${JSON.stringify(dataToken)});`;
      },
      buildStart() {
        if (config.command !== "build" || !["rsc", "ssr"].includes(this.environment.name)
          || this.environment.config.build.write === false) return;
        if (!started) throw new Error("Startup assets require the application build lifecycle");
        // A separate generated entry confines token replacement and map removal
        // to data, preserving ordinary application chunks and their source maps.
        this.emitFile({ type: "chunk", id: startupAssetsModule, fileName: serverDataFile, preserveSignature: "strict" });
      },
      generateBundle: { order: "post", handler(_options, bundle, isWrite) {
        if (!isWrite) return; // RSC/SSR reference scans never become production data.
        if (this.environment.name === "client") {
          const environmentConfig = this.environment.config;
          const renderUrl = environmentConfig.experimental.renderBuiltUrl;
          manifest = createStartupAssetManifest(bundle, {
            root: config.root,
            base: environmentConfig.base,
            assetUrl(fileName) {
              const custom = renderUrl?.(fileName, { type: "asset", hostId: "app/private/page.tsx", hostType: "html", ssr: false });
              if (typeof custom === "string") return custom;
              if (custom?.runtime || custom?.relative) throw new Error("Startup assets require build-time public URLs");
              return startupAssetUrl(fileName, environmentConfig.base);
            },
          });
          this.emitFile({ type: "asset", fileName: startupAssetsFile, source: `${JSON.stringify(manifest, null, 2)}\n` });
          return;
        }
        if (!["rsc", "ssr"].includes(this.environment.name)) return;
        const tokens = Object.values(bundle).filter((item) => item.type === "chunk" && item.code.includes(dataToken));
        const chunk = tokens[0];
        if (tokens.length !== 1 || chunk.type !== "chunk" || chunk.moduleIds.length !== 1
          || chunk.moduleIds[0] !== resolvedModule || pending.has(this.environment.name)) {
          const detail = { environment: this.environment.name, count: tokens.length, duplicate: pending.has(this.environment.name), chunks: tokens.map((item) => item.type === "chunk" ? {
            file: item.fileName, modules: item.moduleIds.slice(0, 8).map((id) => cleanModuleId(id).replace(config.root, "<root>")),
          } : {}) };
          throw new Error(`Startup data must occupy one isolated current-build server module: ${JSON.stringify(detail)}`);
        }
        startupAssetUrl(chunk.fileName); // Validate the current output path before later filesystem access.
        // This generated data-only module has no useful source mapping. It is
        // the sole file whose length changes after bundling; other maps remain intact.
        if (chunk.sourcemapFileName) delete bundle[chunk.sourcemapFileName];
        delete bundle[`${chunk.fileName}.map`];
        chunk.code = chunk.code.replace(/\n?\/\/[#@] sourceMappingURL=[^\r\n]*/g, "");
        chunk.map = null;
        chunk.sourcemapFileName = null;
        pending.set(this.environment.name, { fileName: chunk.fileName, code: chunk.code });
      } },
    },
    {
      name: "stable-earn:startup-assets-finalize",
      // Vinext's finalizer is last; fill current-build server data before it
      // renders static HTML. Never read a previous build's resource mapping.
      buildApp: { order: "post", async handler(builder) {
        if (!manifest || !pending.has("rsc") || !pending.has("ssr")) throw new Error("Incomplete current-build startup assets");
        const finalizedManifest = manifest;
        const writes = await Promise.all([...pending].map(async ([environment, output]) => {
          const outDir = builder.environments[environment]?.config.build.outDir;
          if (!outDir) throw new Error("Missing startup server output environment");
          const file = resolve(config.root, outDir, output.fileName);
          if (await readFile(file, "utf8") !== output.code) throw new Error("Startup data output differs from the current build");
          return { file, temp: `${file}.${randomUUID()}.tmp`, code: fillStartupAssetToken(output.code, finalizedManifest) };
        }));
        try {
          await Promise.all(writes.map((item) => writeFile(item.temp, item.code, { flag: "wx" })));
          for (const item of writes) await rename(item.temp, item.file);
        } finally {
          await Promise.all(writes.map((item) => rm(item.temp, { force: true })));
        }
        pending.clear();
        started = false;
      } },
    },
  ];
}
