import handler from "vinext/server/fetch-handler";
import { enqueueScheduledRefresh, consumeScheduledRefresh, type ScheduledSyncJob } from "@/lib/scheduled-sync";

type WorkerEnv = Cloudflare.Env & { SYNC_QUEUE: Queue<ScheduledSyncJob> };

export default {
  fetch: handler.fetch,
  scheduled(controller: ScheduledController, env: WorkerEnv, context: ExecutionContext) {
    context.waitUntil(enqueueScheduledRefresh(env.SYNC_QUEUE, controller.scheduledTime));
  },
  queue(batch: MessageBatch<ScheduledSyncJob>) {
    return consumeScheduledRefresh(batch);
  },
} satisfies ExportedHandler<WorkerEnv, ScheduledSyncJob>;
