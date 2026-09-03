import handler from "vinext/server/fetch-handler";
import { getDatabase } from "@/lib/db";
import { listPrivateSyncUserIds, refreshPrivateProductsCache } from "@/app/private/api/products/route";

const scheduledRetryDelays = [0, 60_000, 5 * 60_000] as const;

async function scheduledRefresh() {
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
          acceptPartial: finalAttempt,
          persistFailure: finalAttempt,
          recordAttempt: finalAttempt,
        });
      } catch (error) {
        failedUserIds.push(userId);
        const message = error instanceof Error ? error.message : "unknown error";
        console.warn(`Scheduled refresh attempt ${attemptIndex + 1} failed: ${message}`);
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
