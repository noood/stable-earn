import { AsyncLocalStorage } from "node:async_hooks";
import { startupTimingMetrics, startupTimingPhases, type StartupTimingMetric, type StartupTimingPhase } from "./startup-timing-format";

export type StartupServerTiming = {
  enabled: boolean;
  measure<T>(phase: StartupTimingPhase, operation: () => Promise<T>): Promise<T>;
  record(metric: StartupTimingMetric, value: unknown): void;
};

const context = new AsyncLocalStorage<StartupServerTiming | undefined>();
export function currentStartupTiming() { return context.getStore(); }

/** Adds temporary server durations to authenticated page-data responses only
 * when the caller explicitly enables the private startup diagnostics panel.
 */
export async function withStartupServerTiming(
  request: Request,
  handler: (timing: StartupServerTiming) => Promise<Response>,
): Promise<Response> {
  if (new URL(request.url).searchParams.get("diagnostics") !== "1") {
    return context.run(undefined, () => handler({ enabled: false, measure: (_phase, operation) => operation(), record: () => {} }));
  }

  const startedAt = performance.now();
  const spans: Array<{ phase: StartupTimingPhase; start: number; end: number }> = [];
  const values = new Map<StartupTimingMetric, number>();
  const timing: StartupServerTiming = {
    enabled: true,
    async measure(phase, operation) {
      const start = performance.now() - startedAt;
      try { return await operation(); }
      finally {
        if (Object.hasOwn(startupTimingPhases, phase)) spans.push({ phase, start, end: performance.now() - startedAt });
      }
    },
    record(metric, value) {
      if (Object.hasOwn(startupTimingMetrics, metric) && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e12) {
        values.set(metric, value);
      }
    },
  };
  const response = await context.run(timing, () => handler(timing));
  const duration = Math.max(0, performance.now() - startedAt);
  // Response assembly and lock release can overlap. Subtract the union of
  // measured intervals, rather than adding overlapping durations twice.
  let covered = 0;
  let coveredUntil = 0;
  const ordered = spans.sort((a, b) => a.start - b.start);
  for (const span of ordered) {
    covered += Math.max(0, span.end - Math.max(span.start, coveredUntil));
    coveredUntil = Math.max(coveredUntil, span.end);
  }
  const metrics = [
    `app;dur=${duration.toFixed(1)}`,
    ...ordered.map((span) => `${span.phase};dur=${Math.max(0, span.end - span.start).toFixed(1)};desc="start=${span.start.toFixed(1)}"`),
    ...(ordered.length ? [`other;dur=${Math.max(0, duration - covered).toFixed(1)}`] : []),
    ...[...values].map(([name, value]) => `${name};desc="value=${Number(value.toFixed(3))}"`),
  ];
  const headers = new Headers(response.headers);
  headers.set("Server-Timing", metrics.join(","));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
