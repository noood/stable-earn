import { startupTimingPhases, type StartupTimingPhase } from "./startup-timing-format";

export type StartupServerTiming = {
  measure<T>(phase: StartupTimingPhase, operation: () => Promise<T>): Promise<T>;
};

/** Adds temporary server durations to authenticated page-data responses only
 * when the caller explicitly enables the private startup diagnostics panel.
 */
export async function withStartupServerTiming(
  request: Request,
  handler: (timing: StartupServerTiming) => Promise<Response>,
): Promise<Response> {
  if (new URL(request.url).searchParams.get("diagnostics") !== "1") {
    return handler({ measure: (_phase, operation) => operation() });
  }

  const startedAt = performance.now();
  const spans: Array<{ phase: StartupTimingPhase; start: number; end: number }> = [];
  const response = await handler({
    async measure(phase, operation) {
      const start = performance.now() - startedAt;
      try { return await operation(); }
      finally {
        if (Object.hasOwn(startupTimingPhases, phase)) spans.push({ phase, start, end: performance.now() - startedAt });
      }
    },
  });
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
  ];
  const headers = new Headers(response.headers);
  headers.set("Server-Timing", metrics.join(","));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
