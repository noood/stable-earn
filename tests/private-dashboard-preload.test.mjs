import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

function shell({ browser = true, failurePreview = false, production = false, downloadFails = false } = {}) {
  const effects = [], updates = [], diagnostics = [], timers = [];
  let imports = 0, stateIndex = 0;
  const Dashboard = () => null;
  const mocks = {
    react: {
      useEffect: (effect) => effects.push(effect),
      useState: (initial) => {
        const index = stateIndex++;
        return [initial, (next) => updates.push({ index, next })];
      },
    },
    "@/app/components/dashboard/dashboard-skeleton": {},
    "./dashboard-module-preload": { DashboardModulePreload: () => null },
    "@/app/components/startup-diagnostics": { reportStartupDiagnostic: (...args) => diagnostics.push(args) },
  };
  Object.defineProperty(mocks, "@/app/components/dashboard/dashboard", { get() {
    imports++;
    if (downloadFails) throw new Error("module download failed");
    return { Dashboard };
  } });
  const load = moduleLoader(mocks, {
    window: browser ? {
      location: { search: failurePreview ? "?moduleScenario=error" : "" },
      setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
      clearTimeout: () => {},
    } : undefined,
    performance: { now: () => 25 + imports * 10 },
    process: { env: { NODE_ENV: production ? "production" : "development" } },
  });
  const component = load("@/app/private/private-dashboard-client.tsx").default;
  return { Dashboard, updates, diagnostics, timers, imports: () => imports, mount() {
    stateIndex = 0;
    component();
    return effects.at(-1)();
  } };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("dashboard code loads before mounting but its component and account effects do not run", async () => {
  const run = shell();
  assert.ok(run.diagnostics.some(([key]) => key === "dashboard-import"));
  await settle();
  assert.equal(run.imports(), 1);
  assert.equal(run.updates.length, 0);
  assert.ok(run.diagnostics.some(([key]) => key === "dashboard-module"));
  run.mount();
  await settle();
  assert.equal(run.imports(), 1);
  assert.equal(run.updates.length, 1);
  assert.equal(run.updates[0].next(), run.Dashboard);
  run.mount();
  await settle();
  assert.equal(run.imports(), 1, "StrictMode/remount consumers share one import");
});

test("SSR never loads the dashboard module", async () => {
  const run = shell({ browser: false });
  await settle();
  assert.equal(run.imports(), 0);
  assert.equal(run.diagnostics.filter(([key]) => key === "dashboard-import").length, 0);
});

test("download failure before mount is handled and becomes the original module error state", async () => {
  const run = shell({ downloadFails: true });
  await settle();
  assert.equal(run.imports(), 1);
  assert.equal(run.updates.length, 0);
  run.mount();
  await settle();
  assert.deepEqual(run.updates, [{ index: 1, next: true }]);
  assert.equal(run.diagnostics.some(([key]) => key === "dashboard-module"), false);
});

test("an unmounted shell does not update from an already-started load", async () => {
  const run = shell();
  const cleanup = run.mount();
  cleanup();
  await settle();
  assert.equal(run.updates.length, 0);
});

test("local failure preview skips loading and retains the one-second failure", async () => {
  const run = shell({ failurePreview: true });
  run.mount();
  await settle();
  assert.equal(run.imports(), 0);
  run.timers.find(({ delay }) => delay === 1_000).callback();
  assert.deepEqual(run.updates, [{ index: 1, next: true }]);
});

test("production ignores the local failure query", async () => {
  const run = shell({ failurePreview: true, production: true });
  await settle();
  assert.equal(run.imports(), 1);
});
