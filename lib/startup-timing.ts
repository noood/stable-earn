import { AsyncLocalStorage } from "node:async_hooks";
import { startupTimingMetrics, startupTimingPhases, type StartupTimingMetric, type StartupTimingPhase } from "./startup-timing-format";

export type StartupServerTiming = {
  enabled: boolean;
  measure<T>(phase: StartupTimingPhase, operation: () => Promise<T>): Promise<T>;
  record(metric: StartupTimingMetric, value: unknown): void;
};

const context = new AsyncLocalStorage<StartupServerTiming | undefined>();
const slowReadMetricNames = new Set<StartupTimingMetric>([
  "snapshot_sql", "snapshot_d1", "snapshot_attempts",
  "history_summary_sql", "history_summary_d1", "history_summary_attempts",
]);
type SlowReadErrorKind = "timeout" | "aborted" | "type_error" | "syntax_error" | "unsupported_schema_version" | "schema_initialization_incomplete" | "other";
function slowReadErrorKind(error: unknown): SlowReadErrorKind {
  if (!(error instanceof Error)) return "other";
  if (error.message === "Unsupported database schema version") return "unsupported_schema_version";
  if (error.message === "Database schema initialization failed") return "schema_initialization_incomplete";
  if (error.name === "TimeoutError") return "timeout";
  if (error.name === "AbortError") return "aborted";
  if (error.name === "TypeError") return "type_error";
  if (error.name === "SyntaxError") return "syntax_error";
  return "other";
}
export function currentStartupTiming() { return context.getStore(); }

/** Adds temporary server durations to authenticated page-data responses only
 * when the caller explicitly enables the private startup diagnostics panel.
 */
export async function withStartupServerTiming(
  request: Request,
  handler: (timing: StartupServerTiming) => Promise<Response>,
  options?: { watchSlowProductRead?: boolean; watchSlowHoldingsRead?: boolean },
): Promise<Response> {
  const enabled = new URL(request.url).searchParams.get("diagnostics") === "1";
  const watchRead = options?.watchSlowProductRead ? "product_cache_read" : options?.watchSlowHoldingsRead ? "holdings_read" : undefined;
  if (!enabled && !watchRead) {
    return context.run(undefined, () => handler({ enabled: false, measure: (_phase, operation) => operation(), record: () => {} }));
  }

  const startedAt = performance.now();
  const spans: Array<{ phase: StartupTimingPhase; start: number; end: number; outcome: "ok" | "error"; errorKind?: SlowReadErrorKind }> = [];
  const active = new Map<number, { phase: StartupTimingPhase; start: number }>();
  let sequence = 0;
  let slowReported = false;
  const values = new Map<StartupTimingMetric, number>();
  const requestId = watchRead ? crypto.randomUUID() : undefined;
  const slowTimer = watchRead ? setTimeout(() => {
    slowReported = true;
    console.warn({
      event: `${watchRead}_slow`,
      requestId,
      elapsedMs: Math.round(performance.now() - startedAt),
      active: [...active.values()].map(({ phase, start }) => ({ phase, startedMs: Math.round(start) })),
      completed: spans.map(({ phase, start, end, outcome, errorKind }) => ({ phase, outcome, durationMs: Math.round(end - start), ...(errorKind ? { errorKind } : {}) })),
      metrics: Object.fromEntries([...values].filter(([metric]) => slowReadMetricNames.has(metric))),
    });
  }, 5_000) : undefined;
  const timing: StartupServerTiming = {
    enabled,
    async measure(phase, operation) {
      if (!Object.hasOwn(startupTimingPhases, phase)) return operation();
      const start = performance.now() - startedAt;
      const id = sequence++;
      active.set(id, { phase, start });
      if (slowReported) console.info({ event: `${watchRead}_phase`, requestId, phase, state: "started", elapsedMs: Math.round(start) });
      let outcome: "ok" | "error" = "ok";
      let errorKind: SlowReadErrorKind | undefined;
      try { return await operation(); }
      catch (error) { outcome = "error"; errorKind = slowReadErrorKind(error); throw error; }
      finally {
        active.delete(id);
        const end = performance.now() - startedAt;
        spans.push({ phase, start, end, outcome, errorKind });
        if (slowReported) console.info({ event: `${watchRead}_phase`, requestId, phase, state: outcome, elapsedMs: Math.round(end), durationMs: Math.round(end - start), ...(errorKind ? { errorKind } : {}) });
        if (watchRead && outcome === "error" && (phase === "database_init_marker" || phase === "database_init_schema")) {
          console.warn({ event: "database_init_failed", source: watchRead, requestId, phase, durationMs: Math.round(end - start), errorKind });
        }
      }
    },
    record(metric, value) {
      if (Object.hasOwn(startupTimingMetrics, metric) && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e12) {
        values.set(metric, value);
        if (slowReported && slowReadMetricNames.has(metric)) {
          console.info({ event: `${watchRead}_metric`, requestId, metric, value });
        }
      }
    },
  };
  let response: Response;
  try {
    response = await context.run(timing, () => handler(timing));
  } catch (error) {
    if (slowReported) console.warn({ event: `${watchRead}_finished`, requestId, outcome: "error", elapsedMs: Math.round(performance.now() - startedAt) });
    throw error;
  } finally {
    if (slowTimer !== undefined) clearTimeout(slowTimer);
  }
  const duration = Math.max(0, performance.now() - startedAt);
  if (slowReported) console.info({ event: `${watchRead}_finished`, requestId, outcome: "response", status: response.status, elapsedMs: Math.round(duration) });
  if (!enabled) return response;
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
