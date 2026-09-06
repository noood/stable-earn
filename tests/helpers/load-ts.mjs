import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const root = resolve(import.meta.dirname, "../..");
const nativeRequire = createRequire(import.meta.url);

// Run real application modules with in-memory exchange/DB boundaries. No
// network, credentials or production database is required for these tests.
export function moduleLoader(mocks = {}, globals = {}) {
  const modules = new Map();
  function load(id, parent = root) {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    if (!id.startsWith(".") && !id.startsWith("@/") && !id.startsWith("/")) return nativeRequire(id);
    let file = id.startsWith("@/") ? resolve(root, id.slice(2)) : resolve(parent, id);
    if (!existsSync(file)) file += ".ts";
    if (modules.has(file)) return modules.get(file).exports;
    const loadedModule = { exports: {} };
    modules.set(file, loadedModule);
    const source = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    new Function("require", "module", "exports", ...Object.keys(globals), source)(
      (name) => load(name, dirname(file)), loadedModule, loadedModule.exports, ...Object.values(globals),
    );
    return loadedModule.exports;
  }
  return load;
}
