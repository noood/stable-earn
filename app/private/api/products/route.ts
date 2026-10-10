import { NextResponse } from "next/server";
import { getDatabase, getUserIdentity, isScheduledSyncEnabled } from "@/lib/db";
import { isSameOriginMutation, privateResponseHeaders } from "@/lib/request-security";
import { loadManualRefreshCooldown, manualRefreshCooldownMs } from "@/lib/user-settings";
import { isLocalPreviewRequest, localPreviewTime, localPrivateProductsPreview, localSyncScenarioPreview } from "@/lib/local-preview";
import { cachedHoldingTimes } from "@/lib/holding-cache";
import { loadProductChangeEvents } from "@/lib/product-change-events";
import { acquireRefresh, claimDailyRefresh, refreshIsLocked, releaseRefresh } from "@/lib/refresh-control";
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

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (params.has("refresh") || params.has("visit")) {
    return NextResponse.json({ error: "刷新请求必须使用 POST。" }, {
      status: 405,
      headers: { ...privateResponseHeaders, Allow: "POST" },
    });
  }
  return handleProductsRequest(request, false);
}

export async function POST(request: Request) {
  const identity = await getUserIdentity(request);
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
  return handleProductsRequest(request, true, identity);
}

async function handleProductsRequest(request: Request, refreshAllowed: boolean, knownIdentity?: Awaited<ReturnType<typeof getUserIdentity>>) {
  const identity = knownIdentity ?? await getUserIdentity(request);
  if (!identity) return NextResponse.json({ error: "请先登录。" }, { status: 401, headers: privateResponseHeaders });
  const ownerId = identity.userId;
  const scheduledSyncEnabled = isScheduledSyncEnabled();
  if (isLocalPreviewRequest(request)) {
    const scenario = new URL(request.url).searchParams.get("syncScenario");
    if (scenario === "product-read-error" || scenario === "both-read-error") {
      return NextResponse.json({ error: "本地模拟：交易所缓存读取失败" }, { status: 503, headers: privateResponseHeaders });
    }
    const previewNow = localPreviewTime(request.url);
    const preview = localSyncScenarioPreview(scenario, previewNow) ?? localPrivateProductsPreview(previewNow);
    const responsePreview = !scheduledSyncEnabled && preview.cache
      ? { ...preview, cache: { ...preview.cache, scheduledAt: null, scheduledState: "disabled" as const } }
      : preview;
    return NextResponse.json(responsePreview, { status: scenario === "initial-error" ? 502 : 200, headers: privateResponseHeaders });
  }

  const db = await getDatabase();
  const params = new URL(request.url).searchParams;
  const manual = refreshAllowed && params.get("refresh") === "1";
  const daily = refreshAllowed && !manual && params.get("visit") === "1";
  const manualCooldownDuration = manualRefreshCooldownMs(await loadManualRefreshCooldown(db, identity.userId));
  let pending = false;
  async function reply(response: Response) {
    const body = await response.json() as Record<string, unknown>;
    const cache = body.cache;
    if (!scheduledSyncEnabled && cache && typeof cache === "object" && !Array.isArray(cache)) {
      body.cache = { ...(cache as Record<string, unknown>), scheduledAt: null, scheduledState: "disabled" };
    }
    await recordDueManualMaturities(db, ownerId);
    const changeEvents = await loadProductChangeEvents(db, ownerId);
    return NextResponse.json({ ...body, changeEvents, dailyRefreshPending: daily && pending }, {
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
    const busy = await refreshIsLocked(db, identity.userId);
    return reply(snapshot(await loadSyncCache(db, identity.userId, privateCacheKey), busy));
  }
  const token = await acquireRefresh(db, identity.userId);
  if (!token) {
    pending = true;
    return reply(snapshot(await loadSyncCache(db, identity.userId, privateCacheKey), true));
  }
  try {
    const cached = await loadSyncCache<PrivateProductsPayload>(db, identity.userId, privateCacheKey);
    const now = Date.now();
    // Reserve the whole scheduled retry window, not just an individual request.
    if (scheduledSyncEnabled && scheduledRefreshPending(now, syncCacheMetadata(cached, syncAttemptInProgress(cached, now) ? "syncing" : "fresh", now))) {
      pending = true;
      return reply(snapshot(cached, true));
    }
    if (daily && !await claimDailyRefresh(db, identity.userId, token)) return reply(snapshot(cached));
    const cooldownUntil = manualCooldownUntil(cached, now, manualCooldownDuration);
    if (manual && cooldownUntil) {
      if (cached?.payload) return reply(cachedResponse(cached, "cooldown", `手动刷新冷却中，可在 ${formatCacheTime(cooldownUntil)} 后重试。`, now, manualCooldownDuration));
      return reply(NextResponse.json({ error: `手动刷新冷却中，可在 ${formatCacheTime(cooldownUntil)} 后重试。` }, { status: 429 }));
    }
    try {
      const saved = await refreshPrivateProductsCache(db, identity.userId, { manual, trigger: daily ? "daily" : "manual", leaseToken: token });
      return reply(cachedResponse(saved, "updated", "已完成刷新。", Date.now(), manualCooldownDuration));
    } catch {
      return reply(snapshot(await loadSyncCache(db, identity.userId, privateCacheKey)));
    }
  } finally {
    await releaseRefresh(db, identity.userId, token);
  }
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
      ? cachedHoldingTimes(payload.holdingUpdates, payload.holdingFallbacks ?? {}, record.updatedAt ?? payload.fetchedAt)
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
