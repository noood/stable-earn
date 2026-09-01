const DEFAULT_RETRY_DELAY_MS = 800;

export async function exchangeFetch(input: string, init?: RequestInit) {
  let response = await fetch(input, init);
  if (!isRetryableStatus(response.status)) return response;

  const delayMs = retryDelay(response.headers.get("Retry-After"));
  await response.body?.cancel().catch(() => undefined);
  await delay(delayMs);
  response = await fetch(input, init);
  return response;
}

function isRetryableStatus(status: number) {
  return status === 429 || status >= 500;
}

function retryDelay(retryAfter: string | null) {
  const seconds = Number.parseFloat(retryAfter ?? "");
  if (!Number.isFinite(seconds)) return DEFAULT_RETRY_DELAY_MS;
  return Math.min(3000, Math.max(500, seconds * 1000));
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
