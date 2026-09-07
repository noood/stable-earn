import { getDatabase } from "@/lib/db";
import { listPrivateSyncUserIds, refreshPrivateProductsCache } from "@/app/private/api/products/route";
import { loadSyncCache } from "@/lib/sync-cache";
import { diagnosticErrorKind, syncDiagnostic, withSyncDiagnostics } from "@/lib/sync-diagnostics";

export type ScheduledSyncJob = { userId: string; scheduledAt: number };
const slotDurationMs = 12 * 60 * 60 * 1000;

export async function enqueueScheduledRefresh(queue: Queue<ScheduledSyncJob>, scheduledTime: number) {
  // Normalize delivery jitter, retaining the scheduled hour (UTC 22/10).
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
  const finalAttempt = attempt >= 3;
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
      const cached = await loadSyncCache(db, job.userId, "private-products");
      // Queues deliver at least once. Do not repeat a committed run or overwrite
      // a newer manual result; a persisted final error also completes this slot.
      if (Date.parse(cached?.updatedAt ?? "") >= job.scheduledAt
        || (cached?.lastError && cached.lastAttemptAt !== cached.lastManualAt
          && Date.parse(cached.lastAttemptAt ?? "") >= job.scheduledAt)) {
        syncDiagnostic("sync_skipped", { reason: "slot_already_resolved" });
        message.ack();
        return;
      }
      await refreshPrivateProductsCache(db, job.userId, {
        trigger: "scheduled", attempt, runId: `scheduled:${job.scheduledAt}`,
        acceptPartial: finalAttempt, persistFailure: finalAttempt, recordAttempt: true,
      });
      message.ack();
    } catch (error) {
      if (!finalAttempt) {
        const delaySeconds = attempt === 1 ? 60 : 300;
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
