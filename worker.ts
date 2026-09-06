import handler from "vinext/server/fetch-handler";
import { getDatabase } from "@/lib/db";
import { listPrivateSyncUserIds, refreshPrivateProductsCache } from "@/app/private/api/products/route";

const scheduledRetryDelays = [0, 60_000, 5 * 60_000] as const;

async function scheduledRefresh() {
  const runId = crypto.randomUUID();
  const db = await getDatabase();
  let pendingUserIds = await listPrivateSyncUserIds(db);

  for (const [attemptIndex, delay] of scheduledRetryDelays.entries()) {
    if (pendingUserIds.length === 0) return;
    if (delay > 0) await scheduler.wait(delay);

    const failedUserIds: string[] = [];
    const finalAttempt = attemptIndex === scheduledRetryDelays.length - 1;
    for (const userId of pendingUserIds) {
      try {
        await refreshPrivateProductsCache(db, userId, {
          trigger: "scheduled", attempt: attemptIndex + 1, runId,
          acceptPartial: finalAttempt,
          persistFailure: finalAttempt,
          // Record every attempt so the UI can show the retry window while
          // the first two attempts are still in progress.
          recordAttempt: true,
        });
      } catch {
        failedUserIds.push(userId);
        // The refresh logs its correlated outcome before rethrowing.
      }
    }
    pendingUserIds = failedUserIds;
  }
}

export default {
  fetch: handler.fetch,
  scheduled(_controller: ScheduledController, _env: Cloudflare.Env, context: ExecutionContext) {
    context.waitUntil(scheduledRefresh());
  },
} satisfies ExportedHandler<Cloudflare.Env>;
