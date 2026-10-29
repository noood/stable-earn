import { NextResponse } from "next/server";
import { getDatabase, getUserIdentity, isScheduledSyncEnabled } from "@/lib/db";
import { isSameOriginMutation, privateResponseHeaders } from "@/lib/request-security";
import { loadManualRefreshCooldown, manualRefreshCooldownMs } from "@/lib/user-settings";
import { delayLocalPreviewScenario, isLocalPreviewRequest, localPreviewTime, localPrivateProductsPreview, localSyncScenarioPreview } from "@/lib/local-preview";
import { cachedHoldingTimes } from "@/lib/holding-cache";
import { loadProductChangeEvents, loadProductHistorySummaries } from "@/lib/product-change-events";
import { acquireRefresh, dailyRefreshCompleted, refreshDay, releaseRefresh } from "@/lib/refresh-control";
import { loadPrivateProductsSnapshot } from "@/lib/private-products-snapshot";
import { syncDiagnostic, withSyncDiagnostics } from "@/lib/sync-diagnostics";
import { sanitizeSyncFailure, scheduledRefreshPending } from "@/lib/sync-notice";
import {
  formatCacheTime,
  loadSyncCache,
  manualCooldownUntil,
  syncAttemptInProgress,
  syncCacheMetadata,
  type SyncCacheRecord,
  type SyncCacheState,
} from "@/lib/sync-cache";
import type { PrivateProductsPayload } from "@/lib/private-sync/types";
import { legacyFailures, normalizeLegacyNote } from "@/lib/private-sync/status";
import { privateCacheKey, recordDueManualMaturities, refreshPrivateProductsCache } from "@/lib/private-sync/service";
import { withStartupServerTiming, type StartupServerTiming } from "@/lib/startup-timing";

type DailyRefreshDiagnostic = {
  state: "completed" | "waiting" | "skipped" | "failed" | "interrupted";
  reason?: "refresh_in_progress" | "scheduled_retry_window" | "already_attempted_today";
  result?: "success" | "partial" | "unknown";
};

export async function GET(request: Request) {
  return withStartupServerTiming(request, (timing) => getProducts(request, timing));
}

async function getProducts(request: Request, timing: StartupServerTiming) {
  const params = new URL(request.url).searchParams;
  if (params.has("refresh") || params.has("visit")) {
    return NextResponse.json({ error: "刷新请求必须使用 POST。" }, {
      status: 405,
      headers: { ...privateResponseHeaders, Allow: "POST" },
    });
  }
  return handleProductsRequest(request, false, timing);
}

export async function POST(request: Request) {
  return withStartupServerTiming(request, (timing) => postProducts(request, timing));
}

async function postProducts(request: Request, timing: StartupServerTiming) {
  const identity = await timing.measure("auth", () => getUserIdentity(request));
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  if (!isSameOriginMutation(request)) return NextResponse.json({ error: "请求来源无效。" }, { status: 403, headers: privateResponseHeaders });

  const params = new URL(request.url).searchParams;
  const refresh = params.get("refresh");
  const visit = params.get("visit");
  const validValues = (refresh === null || refresh === "1") && (visit === null || visit === "1");
  if (!validValues || (refresh === "1") === (visit === "1")) {
    return NextResponse.json({ error: "请指定一种有效的刷新方式。" }, {
      status: 400,
      headers: { ...privateResponseHeaders, Allow: "GET, POST" },
    });
  }
  return handleProductsRequest(request, true, timing, identity);
}

async function handleProductsRequest(request: Request, refreshAllowed: boolean, timing: StartupServerTiming, knownIdentity?: Awaited<ReturnType<typeof getUserIdentity>>) {
  const identity = knownIdentity ?? await timing.measure("auth", () => getUserIdentity(request));
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  const ownerId = identity.userId;
  const scheduledSyncEnabled = isScheduledSyncEnabled();
  if (isLocalPreviewRequest(request)) {
    const scenario = new URL(request.url).searchParams.get("syncScenario");
    if (scenario === "product-read-error" || scenario === "both-read-error") {
      if (scenario === "both-read-error") await delayLocalPreviewScenario(request, scenario);
      return NextResponse.json({ error: "本地模拟：交易所缓存读取失败" }, { status: 503, headers: privateResponseHeaders });
    }
    const previewNow = localPreviewTime(request.url);
    const preview = localSyncScenarioPreview(scenario, previewNow) ?? localPrivateProductsPreview(previewNow, scenario === "api-dates", scenario === "cache-pair");
    const responsePreview = !scheduledSyncEnabled && preview.cache
      ? { ...preview, cache: { ...preview.cache, scheduledAt: null, scheduledState: "disabled" as const } }
      : preview;
    return NextResponse.json(responsePreview, { status: scenario === "initial-error" ? 502 : 200, headers: privateResponseHeaders });
  }

  const db = await timing.measure("database", () => getDatabase());
  const params = new URL(request.url).searchParams;
  const manual = refreshAllowed && params.get("refresh") === "1";
  const daily = refreshAllowed && !manual && params.get("visit") === "1";
  const diagnosticsEnabled = params.get("diagnostics") === "1";
  let manualCooldownDuration: number;
  let pending = false;
  let dailyRefreshDiagnostic: DailyRefreshDiagnostic | undefined;
  function readHistory() {
    // Keep already-open older clients functional across a deployment. Only new
    // clients opt into summaries; they never download the legacy event payload.
    return timing.measure("history", async () => params.get("history") === "summary"
      ? { historySummaries: await loadProductHistorySummaries(db, ownerId, timing.enabled ? timing : undefined) }
      : { changeEvents: await loadProductChangeEvents(db, ownerId, 2000, timing.enabled ? timing : undefined) });
  }
  async function reply(response: Response, maturitiesRecorded = false, dailyRefresh?: { day: string; completed: boolean }, prefetchedHistory?: Awaited<ReturnType<typeof readHistory>>) {
    const body = await response.json() as Record<string, unknown>;
    const cache = body.cache;
    if (!scheduledSyncEnabled && cache && typeof cache === "object" && !Array.isArray(cache)) {
      body.cache = { ...(cache as Record<string, unknown>), scheduledAt: null, scheduledState: "disabled" };
    }
    if (!maturitiesRecorded) await timing.measure("maturities", () => recordDueManualMaturities(db, ownerId));
    const history = prefetchedHistory ?? await readHistory();
    return NextResponse.json({
      ...body,
      ...history,
      ...(dailyRefresh ? { dailyRefresh } : {}),
      dailyRefreshPending: daily && pending,
      ...(daily && diagnosticsEnabled && dailyRefreshDiagnostic ? { dailyRefreshDiagnostic } : {}),
    }, {
      status: response.status, headers: privateResponseHeaders,
    });
  }
  function snapshot(record: SyncCacheRecord<PrivateProductsPayload> | null, busy = false) {
    const now = Date.now();
    const state = busy || syncAttemptInProgress(record, now) ? "syncing" : record?.lastError ? "error" : "fresh";
    if (record?.payload) return cachedResponse(record, state,
      state === "syncing" ? "正在更新数据中，请稍候。" : "已读取保存的数据。", now, manualCooldownDuration);
    if (state === "error" && record) return initialErrorResponse(record, now, manualCooldownDuration);
    return initialSyncingResponse(record, now, manualCooldownDuration, state);
  }

  // Ordinary polls never contact exchanges, including accounts without a cache.
  if (!manual && !daily) {
    const [saved, hasMaturityCandidates, history] = await Promise.all([
      timing.measure("snapshot_read", () => loadPrivateProductsSnapshot<PrivateProductsPayload>(db, ownerId, privateCacheKey)),
      timing.measure("maturities", () => recordDueManualMaturities(db, ownerId)),
      params.get("history") === "summary" ? readHistory() : undefined,
    ]);
    manualCooldownDuration = saved.cooldownMs;
    const day = refreshDay();
    // Counts are monotonic (events are append-only). A parallel summary may
    // predate a concurrent sync commit seen by the cache snapshot. Its count
    // must cover that same snapshot, not just our own maturity writes.
    const historyCoversSnapshot = history?.historySummaries
      && history.historySummaries.reduce((count, summary) => count + summary.eventCount, 0) >= saved.historyEventCount;
    const currentHistory = !hasMaturityCandidates && historyCoversSnapshot ? history : await readHistory();
    return reply(snapshot(saved.record, saved.leaseUntil > Date.now()), true, {
      day,
      completed: saved.dailyDay === day && Boolean(saved.record?.payload || saved.record?.lastError),
    }, currentHistory);
  }
  manualCooldownDuration = manualRefreshCooldownMs(await timing.measure("settings", () => loadManualRefreshCooldown(db, identity.userId)));
  const dailyDay = daily ? refreshDay() : undefined;
  return withSyncDiagnostics(identity.userId, {
    trigger: daily ? "daily" : "manual",
    attempt: 1,
  }, async () => {
    syncDiagnostic("refresh_requested", { mode: daily ? "daily" : "manual" });
    const token = await timing.measure("lock_acquire", () => acquireRefresh(db, identity.userId));
    if (!token) {
      syncDiagnostic("refresh_skipped", { reason: "refresh_in_progress" });
      pending = true;
      if (daily) dailyRefreshDiagnostic = { state: "waiting", reason: "refresh_in_progress" };
      return reply(snapshot(await timing.measure("cache_read", () => loadSyncCache(db, identity.userId, privateCacheKey)), true));
    }
    try {
      const cached = await timing.measure("cache_read", () => loadSyncCache<PrivateProductsPayload>(db, identity.userId, privateCacheKey));
      const now = Date.now();
      // Reserve the whole scheduled retry window, not just an individual request.
      if (scheduledSyncEnabled && scheduledRefreshPending(now, syncCacheMetadata(cached, syncAttemptInProgress(cached, now) ? "syncing" : "fresh", now))) {
        syncDiagnostic("refresh_skipped", { reason: "scheduled_retry_window" });
        pending = true;
        if (daily) dailyRefreshDiagnostic = { state: "waiting", reason: "scheduled_retry_window" };
        return reply(snapshot(cached, true));
      }
      if (daily && await timing.measure("daily_check", () => dailyRefreshCompleted(db, identity.userId, dailyDay))) {
        syncDiagnostic("refresh_skipped", { reason: "daily_refresh_already_committed" });
        dailyRefreshDiagnostic = { state: "skipped", reason: "already_attempted_today" };
        return reply(snapshot(cached));
      }
      const cooldownUntil = manualCooldownUntil(cached, now, manualCooldownDuration);
      if (manual && cooldownUntil) {
        syncDiagnostic("refresh_skipped", { reason: "manual_cooldown" });
        if (cached?.payload) return reply(cachedResponse(cached, "cooldown", `手动刷新冷却中，可在 ${formatCacheTime(cooldownUntil)} 后重试。`, now, manualCooldownDuration));
        return reply(NextResponse.json({ error: `手动刷新冷却中，可在 ${formatCacheTime(cooldownUntil)} 后重试。` }, { status: 429 }));
      }
      syncDiagnostic("refresh_dispatched");
      try {
        const saved = await timing.measure("sync", () => refreshPrivateProductsCache(db, identity.userId, {
          manual,
          trigger: daily ? "daily" : "manual",
          leaseToken: token,
          dailyDay,
        }));
        if (daily) dailyRefreshDiagnostic = { state: "completed", result: saved.payload?.partial ? "partial" : "success" };
        return reply(cachedResponse(saved, "updated", "已完成刷新。", Date.now(), manualCooldownDuration));
      } catch {
        const latest = await timing.measure("cache_read", () => loadSyncCache<PrivateProductsPayload>(db, identity.userId, privateCacheKey));
        if (daily) {
          const committed = await timing.measure("daily_check", () => dailyRefreshCompleted(db, identity.userId, dailyDay));
          dailyRefreshDiagnostic = committed
            ? latest?.lastError
              ? { state: "failed" }
              : { state: "completed", result: latest?.payload?.partial ? "partial" : latest?.payload ? "success" : "unknown" }
            : { state: "interrupted" };
        }
        return reply(snapshot(latest));
      }
    } finally {
      await timing.measure("lock_release", () => releaseRefresh(db, identity.userId, token));
    }
  });
}

function cachedResponse(
  record: SyncCacheRecord<PrivateProductsPayload>,
  state: SyncCacheState,
  statusText: string,
  now: number,
  manualCooldownDuration: number,
) {
  const payload = record.payload!;
  const failures = payload.failures ?? legacyFailures(payload.note);
  const failed = state === "error" || Boolean(record.lastError);
  const responseFailures = state === "syncing" ? [] : failed ? ["产品和持仓数据更新失败"] : failures.map(sanitizeSyncFailure);
  return NextResponse.json({
    ...payload,
    partial: state === "syncing" ? false : payload.partial,
    rateFallbacks: failed
      ? Object.fromEntries(payload.rates.map((rate) => [rate.productId, rate.fetchedAt || record.updatedAt]))
      : payload.rateFallbacks ?? {},
    holdingFallbacks: failed
      ? cachedHoldingTimes(payload.holdingUpdates, payload.holdingFallbacks ?? {}, record.updatedAt ?? payload.fetchedAt, payload.holdingFetchedAt)
      : payload.holdingFallbacks ?? {},
    holdingSyncStates: failed
      ? Object.fromEntries(Object.entries(payload.holdingSyncStates ?? {}).map(([id, status]) => [id, status === "not_configured" ? status : "error"]))
      : payload.holdingSyncStates,
    holdingPositions: payload.holdingPositions ?? [],
    fetchedAt: record.updatedAt ?? payload.fetchedAt,
    cache: syncCacheMetadata(record, state, now, manualCooldownDuration),
    note: state === "syncing" ? statusText : `${statusText} ${normalizeLegacyNote(payload.note)}`.trim(),
    failures: responseFailures,
    fallbackUpdatedAt: state === "syncing" ? null : payload.fallbackUpdatedAt
      ?? (state === "error" ? record.updatedAt : null),
  }, { headers: privateResponseHeaders });
}

function initialSyncingResponse(
  record: SyncCacheRecord<PrivateProductsPayload> | null,
  now: number,
  manualCooldownDuration: number,
  state: SyncCacheState = "syncing",
) {
  return NextResponse.json({
    products: [],
    rates: [],
    rateFallbacks: {},
    holdingUpdates: {},
    holdingSourceIds: [],
    holdingFallbacks: {},
    holdingSyncStates: {},
    holdingPositions: [],
    partial: false,
    note: state === "syncing" ? "正在更新数据中，请稍候。" : "尚无成功数据。",
    failures: [],
    fallbackUpdatedAt: null,
    cache: syncCacheMetadata(record, state, now, manualCooldownDuration),
  }, { headers: privateResponseHeaders });
}

function initialErrorResponse(
  record: SyncCacheRecord<PrivateProductsPayload>,
  now: number,
  manualCooldownDuration: number,
) {
  return NextResponse.json({
    error: "交易所数据暂时无法获取，且当前账户尚无成功缓存。",
    cache: syncCacheMetadata(record, "error", now, manualCooldownDuration),
  }, { status: 502, headers: privateResponseHeaders });
}
