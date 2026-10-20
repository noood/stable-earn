/** Adds a temporary server duration to authenticated page-data responses only
 * when the caller explicitly enables the private startup diagnostics panel.
 */
export async function withStartupServerTiming(
  request: Request,
  handler: () => Promise<Response>,
): Promise<Response> {
  if (new URL(request.url).searchParams.get("diagnostics") !== "1") return handler();

  const startedAt = performance.now();
  const response = await handler();
  const duration = Math.max(0, performance.now() - startedAt).toFixed(1);
  const headers = new Headers(response.headers);
  headers.set("Server-Timing", `app;dur=${duration}`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
