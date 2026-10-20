import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./helpers/load-ts.mjs";

function diagnostics(search = "?diagnostics=1") {
  const events = [];
  const load = moduleLoader({ react: {} }, {
    window: { location: { search }, dispatchEvent: (event) => events.push(event) },
    document: { visibilityState: "visible" },
    performance: { now: () => 100 },
    CustomEvent: class { constructor(type) { this.type = type; } },
  });
  return { ...load("@/app/components/startup-diagnostics.tsx"), events };
}

test("a DOM-commit checkpoint stores its original time without scheduling a diagnostics render", () => {
  const d = diagnostics();
  d.reportStartupDiagnostic("commit", "DOM committed", "time", 42, false);
  assert.equal(d.startupDiagnosticTime("commit"), 42);
  assert.equal(d.events.length, 0);
  d.publishStartupDiagnostics();
  assert.equal(d.events.length, 1);
});

test("ordinary visits retain no startup checkpoints and dispatch no diagnostic updates", () => {
  const d = diagnostics("");
  d.reportStartupDiagnostic("commit", "DOM committed", "time", 42);
  d.publishStartupDiagnostics();
  assert.equal(d.startupDiagnosticTime("commit"), undefined);
  assert.equal(d.events.length, 0);
});
