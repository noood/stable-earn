import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStartupAssetManifest, fillStartupAssetToken, startupAssetUrl, startupAssetsFile, startupAssetsModule, startupAssetsPlugin } from "../scripts/startup-assets.mjs";

const root = "/build/project";
const source = (path) => `${root}/${path}`;
const chunk = (fileName, moduleIds, imports = []) => ({ type: "chunk", fileName, moduleIds, imports });
function clientBundle() {
  return {
    a: chunk("_next/static/chunks/one.js", [source("app/components/dashboard/dashboard.tsx")], ["_next/static/chunks/shared.js"]),
    b: chunk("_next/static/chunks/two.js", [source("app/private/private-dashboard-client.tsx")]),
    c: chunk("_next/static/chunks/shared.js", [source("app/components/startup-diagnostics.tsx"), source("node_modules/react/index.js")], ["_next/static/chunks/leaf.js"]),
    d: chunk("_next/static/chunks/leaf.js", [source("node_modules/vinext/dist/shims/navigation.js")]),
    image: { type: "asset", fileName: "private-looking.svg", source: "not a script" },
  };
}

test("hash-only output is identified by source identity and preloads only the static dependency graph", () => {
  const bundle = clientBundle();
  bundle.a.dynamicImports = ["_next/static/chunks/unrelated.js"];
  bundle.d.imports = ["_next/static/chunks/shared.js"]; // Shared cycles are visited once.
  const manifest = createStartupAssetManifest(bundle, { root });
  assert.deepEqual(manifest.scripts.dashboard, ["/_next/static/chunks/one.js"]);
  assert.deepEqual(manifest.scripts["private-dashboard-client"], ["/_next/static/chunks/two.js"]);
  assert.deepEqual(manifest.scripts.framework, ["/_next/static/chunks/shared.js"]);
  assert.deepEqual(manifest.dashboardPreloads, ["/_next/static/chunks/leaf.js", "/_next/static/chunks/shared.js", "/_next/static/chunks/one.js"]);
  assert.doesNotMatch(JSON.stringify(manifest), /build\/project|node_modules|\.tsx|private-looking|unrelated/);
  const renamed = Object.fromEntries(Object.entries(bundle).map(([key, item]) => [key, item.type === "chunk"
    ? { ...item, fileName: item.fileName.replace("chunks/", "chunks/hash-"), imports: item.imports.map((name) => name.replace("chunks/", "chunks/hash-")) }
    : item]));
  assert.deepEqual(createStartupAssetManifest(renamed, { root }).scripts.dashboard, ["/_next/static/chunks/hash-one.js"]);
});

test("module queries, Windows paths and entry facades do not expose paths or confuse source roles", () => {
  const bundle = clientBundle();
  bundle.a.moduleIds = [source("app/components/dashboard/dashboard.tsx").replaceAll("/", "\\") + "?source=test"];
  bundle.b.facadeModuleId = source("app/private/private-dashboard-client.tsx");
  bundle.b.moduleIds = ["\0virtual:opaque-client-reference"];
  bundle.entry = chunk("_next/static/chunks/entry.js", ["\0virtual:vinext-app-browser-entry"]);
  bundle.runtime = chunk("_next/static/chunks/runtime.js", ["\0rolldown/runtime.js"]);
  bundle.context = chunk("_next/static/chunks/context.js", [source("node_modules/vinext/dist/shims/layout-segment-context.js")]);
  const manifest = createStartupAssetManifest(bundle, { root });
  assert.deepEqual(manifest.scripts.index, ["/_next/static/chunks/entry.js"]);
  assert.deepEqual(manifest.scripts["rolldown-runtime"], ["/_next/static/chunks/runtime.js"]);
  assert.deepEqual(manifest.scripts["layout-segment-context"], ["/_next/static/chunks/context.js"]);
  assert.equal(manifest.scripts.dashboard.length, 1);
});

test("missing critical modules and incomplete static dependencies fail the build instead of reusing old data", () => {
  for (const key of ["a", "b", "c"]) {
    const bundle = clientBundle();
    delete bundle[key];
    assert.throws(() => createStartupAssetManifest(bundle, { root }), /Missing startup source mapping/);
  }
  const bundle = clientBundle();
  delete bundle.d;
  assert.throws(() => createStartupAssetManifest(bundle, { root }), /Missing static dependency/);
  bundle.d = chunk(bundle.a.fileName, []);
  assert.throws(() => createStartupAssetManifest(bundle, { root }), /Duplicate startup output/);
});

test("public bases and configured asset URLs are preserved, without accepting local paths or credentials", () => {
  assert.equal(startupAssetUrl("_next/static/a.js", "/app/"), "/app/_next/static/a.js");
  assert.equal(startupAssetUrl("_next/static/a.js", "https://cdn.example.invalid/site/"), "https://cdn.example.invalid/site/_next/static/a.js");
  assert.equal(startupAssetUrl("_next/static/a.js", "//cdn.example.invalid/"), "//cdn.example.invalid/_next/static/a.js");
  const manifest = createStartupAssetManifest(clientBundle(), { root, assetUrl: (file) => `https://cdn.example.invalid/${file}?dpl=public-build` });
  assert.equal(manifest.scripts.dashboard[0], "https://cdn.example.invalid/_next/static/chunks/one.js?dpl=public-build");
  for (const file of ["../secret.js", "/absolute.js", "C:\\private.js", "script.js?secret=x"]) assert.throws(() => startupAssetUrl(file), /Invalid emitted/);
  assert.throws(() => startupAssetUrl("file.js", "./"), /fixed public base/);
  for (const url of ["file:///private/code.js", "https://user:password@cdn.example.invalid/code.js", "javascript:alert(1)", "<script>.js"]) {
    assert.throws(() => createStartupAssetManifest(clientBundle(), { root, assetUrl: () => url }), /public/);
  }
});

test("data token substitution is exact and safely serializes quotes, backticks and script delimiters", () => {
  const plugins = startupAssetsPlugin();
  const core = plugins[1];
  core.configResolved({ command: "build", root });
  const id = core.resolveId(startupAssetsModule);
  const code = core.load.call({ environment: { name: "rsc", mode: "build" } }, id);
  const manifest = { version: 1, scripts: { dashboard: ["/a`'\"${literal}$&$$$'`</script>\u2028.js"] }, dashboardPreloads: [] };
  const result = fillStartupAssetToken(code, manifest);
  assert.doesNotMatch(result, /<\/script>|__STABLE_EARN_CURRENT_BUILD/);
  const evaluate = new Function(result.replace("export default", "return"));
  assert.deepEqual(evaluate(), manifest);
  assert.deepEqual(new Function(fillStartupAssetToken(code.replaceAll('"', "`"), manifest).replace("export default", "return"))(), manifest);
  assert.throws(() => fillStartupAssetToken("export default {}", manifest), /exactly one/);
  assert.throws(() => fillStartupAssetToken(code + code, manifest), /exactly one/);
});

test("development uses empty data while production rejects client imports and non-isolated data", () => {
  const [prepare, core] = startupAssetsPlugin();
  core.configResolved({ command: "serve", root });
  const id = core.resolveId(startupAssetsModule);
  assert.equal(core.resolveId(id), id);
  assert.deepEqual(new Function(core.load.call({ environment: { name: "rsc", mode: "dev" } }, id).replace("export default", "return"))(), {
    version: 1, scripts: {}, dashboardPreloads: [],
  });
  core.configResolved({ command: "build", root });
  prepare.buildApp.handler();
  const emitted = [];
  core.buildStart.call({ environment: { name: "rsc", config: { build: { write: true } } }, emitFile: (entry) => emitted.push(entry) });
  assert.equal(emitted[0].id, startupAssetsModule);
  assert.equal(core.resolveId(emitted[0].id), id);
  assert.throws(() => core.load.call({ environment: { name: "client", mode: "build" } }, id), /only by a server module/);
  const code = core.load.call({ environment: { name: "rsc", mode: "build" } }, id);
  const context = { environment: { name: "rsc" } };
  assert.doesNotThrow(() => core.generateBundle.handler.call(context, {}, {}, false));
  assert.throws(() => core.generateBundle.handler.call(context, {}, {}, true), /isolated current-build/);
  const mixed = { data: { ...chunk("startup-assets.js", [id, source("app/private/page.tsx")]), code } };
  assert.throws(() => core.generateBundle.handler.call(context, {}, mixed, true), /isolated current-build/);
  const data = { data: { ...chunk("_next/static/generated-data-opaque.js", [id]), code, map: null } };
  assert.doesNotThrow(() => core.generateBundle.handler.call(context, {}, data, true));
  assert.throws(() => core.generateBundle.handler.call(context, {}, data, true), /isolated current-build/);
});

test("the application build embeds one current client manifest in isolated RSC/SSR data modules", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "stable-startup-assets-"));
  try {
    const [prepare, core, finalize] = startupAssetsPlugin();
    core.configResolved({ command: "build", root: scratch });
    prepare.buildApp.handler();
    const id = core.resolveId(startupAssetsModule);
    const code = core.load.call({ environment: { name: "rsc", mode: "build" } }, id);
    const environment = (name) => ({ name, config: { build: { write: true }, base: "/", experimental: {} } });
    for (const name of ["rsc", "ssr"]) {
      const bundle = {
        "startup-assets.js": { ...chunk("startup-assets.js", [id]), code, map: { mappings: "data-only" }, sourcemapFileName: "startup-assets.js.map" },
        "startup-assets.js.map": { type: "asset", source: "generated-data-map" },
        "ordinary.js": { ...chunk("ordinary.js", ["app.tsx"]), code: "export const app = true;", map: { mappings: "keep" } },
      };
      core.generateBundle.handler.call({ environment: environment(name) }, {}, bundle, true);
      assert.equal(bundle["startup-assets.js"].map, null);
      assert.equal(bundle["startup-assets.js.map"], undefined);
      assert.deepEqual(bundle["ordinary.js"].map, { mappings: "keep" });
      await mkdir(join(scratch, name));
      await writeFile(join(scratch, name, "startup-assets.js"), bundle["startup-assets.js"].code);
    }
    const emitted = [];
    const bundle = clientBundle();
    for (const item of Object.values(bundle)) if (item.type === "chunk") item.moduleIds = item.moduleIds.map((module) => module.replace(root, scratch));
    core.generateBundle.handler.call({ environment: environment("client"), emitFile: (file) => emitted.push(file) }, {}, bundle, true);
    assert.equal(emitted[0].fileName, startupAssetsFile);
    const manifest = JSON.parse(emitted[0].source);
    const builder = { environments: { rsc: { config: { build: { outDir: "rsc" } } }, ssr: { config: { build: { outDir: "ssr" } } } } };
    await writeFile(join(scratch, "rsc", "startup-assets.js"), "stale or changed artifact");
    await assert.rejects(finalize.buildApp.handler(builder), /differs from the current build/);
    assert.equal(await readFile(join(scratch, "ssr", "startup-assets.js"), "utf8"), code);
    await writeFile(join(scratch, "rsc", "startup-assets.js"), code);
    await finalize.buildApp.handler(builder);
    const serverCode = await Promise.all(["rsc", "ssr"].map((name) => readFile(join(scratch, name, "startup-assets.js"), "utf8")));
    assert.equal(serverCode[0], serverCode[1]);
    assert.deepEqual(new Function(serverCode[0].replace("export default", "return"))(), manifest);
    prepare.buildApp.handler();
    await assert.rejects(finalize.buildApp.handler(builder), /Incomplete current-build/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
