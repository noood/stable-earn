import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import test from "node:test";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const source = (file) => readFileSync(resolve(root, file), "utf8");

// Inspect runtime imports after removing types. This includes lazy imports and
// transitive local dependencies, not just the component's direct import list.
function runtimeImports(file) {
  const emitted = ts.transpileModule(source(file), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const tree = ts.createSourceFile(file, emitted, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const imports = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return imports;
}

function localImport(file, id) {
  if (!id.startsWith("@/") && !id.startsWith(".")) return null;
  const base = id.startsWith("@/") ? resolve(root, id.slice(2)) : resolve(root, dirname(file), id);
  const found = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
    .find((candidate) => /\.(ts|tsx)$/.test(candidate) && existsSync(candidate));
  assert.ok(found, `unresolved local import ${id} from ${file}`);
  return relative(root, found);
}

function walkImports(entry, check) {
  const visited = new Set();
  function walk(file) {
    if (visited.has(file)) return;
    visited.add(file);
    for (const id of runtimeImports(file)) {
      const target = localImport(file, id);
      check(file, id, target);
      if (target) walk(target);
    }
  }
  walk(entry);
  return visited;
}

test("dashboard runtime dependencies never include credentials, database access, or platform sync services", () => {
  for (const entry of ["app/page.tsx", "app/private/private-dashboard-client.tsx"]) {
    const visited = walkImports(entry, (file, id, target) => {
      assert.doesNotMatch(id, /^(?:cloudflare:workers|node:)/,
        `${file} must not pull server-only code into the browser`);
      if (target) assert.doesNotMatch(target, /^(?:lib\/(?:credentials|db)\.ts$|lib\/(?:private-sync|integrations)\/|app\/private\/api\/)/,
        `${file} must not pull server-only code into the browser`);
    });
    assert.ok(visited.has("app/components/dashboard/dashboard.tsx"));
    assert.ok(visited.has("app/components/dashboard/product-row.tsx"));
  }
});

test("both page entries reuse Dashboard without importing the public page from the private shell", () => {
  const publicPage = source("app/page.tsx");
  const privateClient = source("app/private/private-dashboard-client.tsx");
  assert.match(publicPage, /from ["']@\/app\/components\/dashboard\/dashboard["']/);
  assert.doesNotMatch(publicPage, /(?:export )?function Dashboard\(/);
  assert.match(publicPage, /dynamic = "force-static"/);
  assert.match(publicPage, /\/private\/api\/session/);
  assert.match(publicPage, /window\.location\.replace/);
  assert.match(privateClient, /import\(["']@\/app\/components\/dashboard\/dashboard["']\)/);
  assert.doesNotMatch(privateClient, /@\/app\/page/);
  assert.match(privateClient, /ssr: false/);
  assert.match(privateClient, /reportStartupDiagnostic\("dashboard-module"/);
});

test("input controls remain local and extracted components never depend on their page or container", () => {
  for (const file of ["product-inputs.tsx", "purchase-date-input.tsx", "product-row.tsx"]) {
    const path = `app/components/dashboard/${file}`;
    const imports = runtimeImports(path);
    assert.ok(!imports.some((id) => id === "@/app/page" || /(?:^|\/)dashboard$/.test(id)), `${file} has an upward dependency`);
    const tree = ts.createSourceFile(file, source(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        assert.notEqual(node.expression.text, "fetch", `${file} must use callbacks instead of owning requests`);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
});

test("extracted front-end and sync modules have no runtime import cycles", () => {
  const completed = new Set();
  const stack = [];
  function visit(file) {
    assert.ok(!stack.includes(file), `runtime import cycle: ${[...stack, file].join(" -> ")}`);
    if (completed.has(file)) return;
    stack.push(file);
    for (const id of runtimeImports(file)) {
      const target = localImport(file, id);
      if (target) visit(target);
    }
    stack.pop();
    completed.add(file);
  }
  for (const directory of ["app/components/dashboard", "lib/private-sync"]) {
    for (const file of readdirSync(resolve(root, directory)).filter((name) => /\.tsx?$/.test(name))) {
      visit(`${directory}/${file}`);
    }
  }
});
