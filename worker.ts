import handler from "vinext/server/fetch-handler";
import { getDatabase } from "@/lib/db";
import { listPrivateSyncUserIds, refreshPrivateProductsCache } from "@/app/private/api/products/route";

async function scheduledRefresh() {
  const db = await getDatabase();
  const userIds = await listPrivateSyncUserIds(db);
  for (const userId of userIds) {
    try {
      await refreshPrivateProductsCache(db, userId);
    } catch {
      // One account failure must not prevent the remaining users from updating.
    }
  }
}

export default {
  fetch: handler.fetch,
  scheduled(_controller: ScheduledController, _env: Cloudflare.Env, context: ExecutionContext) {
    context.waitUntil(scheduledRefresh());
  },
} satisfies ExportedHandler<Cloudflare.Env>;
