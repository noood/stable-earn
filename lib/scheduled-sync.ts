import { getDatabase } from "@/lib/db";
import { listPrivateSyncUserIds, refreshPrivateProductsCache } from "@/app/private/api/products/route";
import { loadSyncCache } from "@/lib/sync-cache";
import { acquireRefresh, finishScheduledRefresh, releaseRefresh, scheduledRefreshDone } from "@/lib/refresh-control";
import { diagnosticErrorKind, syncDiagnostic, withSyncDiagnostics } from "@/lib/sync-diagnostics";

export type ScheduledSyncJob = { userId: string; scheduledAt: number };
const slotDurationMs = 24 * 60 * 60 * 1000;

export async function enqueueScheduledRefresh(queue: Queue<ScheduledSyncJob>, scheduledTime: number) {
  // Normalize delivery jitter, retaining the scheduled hour (UTC 23).
  const scheduledAt = Math.floor(scheduledTime / 3_600_000) * 3_600_000;
  const db = await getDatabase();
  const users = await listPrivateSyncUserIds(db);
  // Producer batching does not combine consumer invocations: max_batch_size is 1.
  for (let index = 0; index < users.length; index += 100) {
    await queue.sendBatch(users.slice(index, index + 100).map((userId) => ({ body: { userId, scheduledAt } })));
  }
}

export async function consumeScheduledRefresh(batch: MessageBatch<ScheduledSyncJob>) {
  // Fail closed if deployment settings accidentally reintroduce shared budgets.
  if (batch.messages.length !== 1) throw new Error("Sync queue requires max_batch_size=1");
  const message = batch.messages[0];
  const job = message.body;
  if (!job || typeof job.userId !== "string" || !job.userId || !Number.isFinite(job.scheduledAt)) {
    console.warn({ event: "sync_queue_invalid_job" });
    message.ack();
    return;
  }
  const attempt = message.attempts;
  const finalAttempt = attempt >= 2;
  await withSyncDiagnostics(job.userId, {
    trigger: "scheduled", attempt, runId: `scheduled:${job.scheduledAt}`,
  }, async () => {
    try {
      if (job.scheduledAt > Date.now() || Date.now() >= job.scheduledAt + slotDurationMs) {
        syncDiagnostic("sync_skipped", { reason: "outside_slot" });
        message.ack();
        return;
      }
      const db = await getDatabase();
      const token = await acquireRefresh(db, job.userId);
      if (!token) {
        // A browser refresh already owns the account. Never overlap its writes.
        if (!finalAttempt) message.retry({ delaySeconds: 180 });
        else message.ack();
        syncDiagnostic("sync_skipped", { reason: "refresh_in_progress" });
        return;
      }
      try {
        const cached = await loadSyncCache(db, job.userId, "private-products");
        // A browser failure is not a completed scheduled job. Track queue
        // completion explicitly rather than inferring it from last_error.
        if (Date.parse(cached?.updatedAt ?? "") >= job.scheduledAt
          || await scheduledRefreshDone(db, job.userId, job.scheduledAt)) {
          syncDiagnostic("sync_skipped", { reason: "slot_already_resolved" });
          message.ack();
          return;
        }
        try {
          await refreshPrivateProductsCache(db, job.userId, {
            trigger: "scheduled", attempt, runId: `scheduled:${job.scheduledAt}`,
            leaseToken: token,
            acceptPartial: finalAttempt, persistFailure: finalAttempt, recordAttempt: true,
          });
        } catch (error) {
          if (finalAttempt) await finishScheduledRefresh(db, job.userId, token, job.scheduledAt);
          throw error;
        }
        await finishScheduledRefresh(db, job.userId, token, job.scheduledAt);
        message.ack();
      } finally {
        await releaseRefresh(db, job.userId, token);
      }
    } catch (error) {
      if (!finalAttempt) {
        const delaySeconds = 180;
        syncDiagnostic("sync_retry_queued", { delaySeconds, errorKind: diagnosticErrorKind(error) }, true);
        // A retry is a NEW queue invocation, not a sleep in this invocation.
        message.retry({ delaySeconds });
      } else {
        syncDiagnostic("sync_queue_finished", { outcome: "error", errorKind: diagnosticErrorKind(error) }, true);
        message.ack();
      }
    }
  });
}
