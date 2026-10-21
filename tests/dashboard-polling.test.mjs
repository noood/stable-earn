import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { moduleLoader } from "./helpers/load-ts.mjs";

const { startDashboardPolling } = moduleLoader()("@/lib/dashboard-polling");

function fixture({ hidden = false, lastRequestAt = 0, allowed = true } = {}) {
  let time = 0, timerId = 0;
  const timers = new Map(), listeners = new Set(), requests = [];
  const state = { hidden, lastRequestAt, allowed };
  const options = {
    isHidden: () => state.hidden,
    canPoll: () => state.allowed,
    lastRequestAt: () => state.lastRequestAt,
    poll: () => { state.lastRequestAt = time; requests.push(time); },
    now: () => time,
    setTimer(callback, delay) { const id = ++timerId; timers.set(id, { at: time + delay, callback }); return id; },
    clearTimer: (id) => timers.delete(id),
    subscribeVisibility(callback) { listeners.add(callback); return () => listeners.delete(callback); },
  };
  return {
    state, requests, timers, listeners,
    start: () => startDashboardPolling(options),
    visibility(value) { state.hidden = value; for (const callback of [...listeners]) callback(); },
    advance(ms) {
      const until = time + ms;
      for (let guard = 0; ; guard++) {
        assert.ok(guard < 1000, "timer callbacks must not spin");
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > until) break;
        time = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      time = until;
    },
  };
}

test("foreground requests retain a sixty-second cadence", () => {
  const f = fixture();
  f.start();
  f.advance(59_999);
  assert.deepEqual(f.requests, []);
  f.advance(1);
  assert.deepEqual(f.requests, [60_000]);
  f.advance(120_000);
  assert.deepEqual(f.requests, [60_000, 120_000, 180_000]);
});

test("hidden pages have no timer or new polls; resuming an overdue page reads once without a burst", () => {
  const f = fixture();
  f.start();
  f.advance(10_000);
  f.visibility(true);
  assert.equal(f.timers.size, 0);
  f.advance(300_000);
  assert.deepEqual(f.requests, []);
  f.visibility(false);
  f.visibility(false);
  assert.deepEqual(f.requests, [310_000]);
  f.advance(59_999);
  assert.deepEqual(f.requests, [310_000]);
  f.advance(1);
  assert.deepEqual(f.requests, [310_000, 370_000]);
});

test("a short background interval does not reset the actual request deadline", () => {
  const f = fixture();
  f.start();
  f.advance(20_000); f.visibility(true);
  f.advance(10_000); f.visibility(false);
  f.advance(29_999);
  assert.deepEqual(f.requests, []);
  f.advance(1);
  assert.deepEqual(f.requests, [60_000]);
});

test("manual/daily requests move the deadline and queued polls do not immediately duplicate them", () => {
  const f = fixture();
  f.start();
  f.advance(45_000);
  f.state.lastRequestAt = 45_000;
  f.advance(59_999);
  assert.deepEqual(f.requests, []);
  f.advance(1);
  assert.deepEqual(f.requests, [105_000]);
});

test("in-flight or unavailable personal data guards do not spin or consume a skipped request time", () => {
  const f = fixture({ allowed: false });
  f.start();
  f.advance(180_000);
  assert.deepEqual(f.requests, []);
  assert.equal(f.state.lastRequestAt, 0);
  assert.equal(f.timers.size, 1);
  f.state.allowed = true;
  f.visibility(false);
  assert.deepEqual(f.requests, [180_000]);
});

test("a page initially hidden waits for visibility and the remaining interval", () => {
  const f = fixture({ hidden: true });
  f.start();
  assert.equal(f.timers.size, 0);
  f.advance(30_000);
  f.visibility(false);
  f.advance(30_000);
  assert.deepEqual(f.requests, [60_000]);
});

test("even a queued callback checks hidden state if a visibility event was delayed", () => {
  const f = fixture();
  f.start();
  f.state.hidden = true;
  f.advance(120_000);
  assert.deepEqual(f.requests, []);
  f.visibility(false);
  assert.deepEqual(f.requests, [120_000]);
});

test("cleanup removes listeners and pending timers; StrictMode remount makes only one overdue poll", () => {
  const f = fixture();
  const stop = f.start();
  f.advance(70_000);
  stop();
  assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.size, 0);
  f.advance(120_000);
  const firstCleanup = f.start();
  firstCleanup();
  const finalCleanup = f.start();
  f.advance(0);
  assert.deepEqual(f.requests, [60_000, 190_000]);
  assert.equal(f.listeners.size, 1);
  finalCleanup();
  assert.equal(f.timers.size, 0);
});

test("without a previous request the first poll still waits sixty seconds", () => {
  const f = fixture({ lastRequestAt: null });
  f.start();
  f.advance(59_999);
  assert.deepEqual(f.requests, []);
  f.advance(1);
  assert.deepEqual(f.requests, [60_000]);
});

test("dashboard keeps editing/opening guards, daily pending semantics and real fetch timestamps", () => {
  const dashboard = readFileSync(new URL("../app/components/dashboard/dashboard.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /if \(isDemo \|\| editing \|\| openingLoading \|\| \(!holdingsReady && !dailyRefreshPendingRef\.current\)\) return/);
  assert.match(dashboard, /canPoll: \(\) => !refreshInFlightRef\.current && \(personalDataReadyRef\.current \|\| dailyRefreshPendingRef\.current\)/);
  assert.match(dashboard, /poll: \(\) => \{ void refreshRates\(holdingsRef\.current, \{ silent: true \}\); \}/);
  assert.match(dashboard, /lastProductRequestAtRef\.current = productsRequestStartedAt;\s+const productsResponse = fetch/);
  assert.match(dashboard, /if \(!options\?\.response\) lastProductRequestAtRef\.current = performance\.now\(\);\s+response = await/);
});
