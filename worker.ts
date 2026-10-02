import handler from "vinext/server/fetch-handler";
import { enqueueScheduledRefresh, consumeScheduledRefresh, type ScheduledSyncJob } from "@/lib/scheduled-sync";

type WorkerEnv = Cloudflare.Env & { SYNC_QUEUE: Queue<ScheduledSyncJob> };

const securityHeaders = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
} as const;

export default {
  async fetch(request: Request, env: WorkerEnv, context: ExecutionContext) {
    const response = await handler.fetch(request, env, context);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  scheduled(controller: ScheduledController, env: WorkerEnv, context: ExecutionContext) {
    context.waitUntil(enqueueScheduledRefresh(env.SYNC_QUEUE, controller.scheduledTime));
  },
  queue(batch: MessageBatch<ScheduledSyncJob>) {
    return consumeScheduledRefresh(batch);
  },
} satisfies ExportedHandler<WorkerEnv, ScheduledSyncJob>;
