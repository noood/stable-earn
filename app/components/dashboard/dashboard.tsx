"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ApiSettings } from "@/app/components/api-settings";
import { useDismissibleDetails } from "@/app/components/use-dismissible-details";
import { ProductRow, overflowFromFirstTier, formatSyncDateTime, type ManualProductPatch } from "@/app/components/dashboard/product-row";
import type { ProductHistoryPage } from "@/app/components/product-history";
import { ActionButton, Metric, MetricSkeleton, ModalFrame, TableCell } from "@/app/components/ui";
import { reportStartupDiagnostic } from "@/app/components/startup-diagnostics";
import { effectiveApr, formatAmount, type Asset, type HoldingMap, type HoldingPosition, type HoldingSyncState, type Product, type ProductChangeEvent } from "@/lib/domain";
import { applyProductOverride, type ProductOverride, type ProductOverrideMap } from "@/lib/product-overrides";
import { productInformationIssues, productParticipatesInInterest, type ProductInformationIssue } from "@/lib/product-status";
import { completedDataSummary, dashboardReadState, scheduledRefreshPending, serverReadFailureMessage, syncFailureSummary } from "@/lib/sync-notice";
import { publicDemoChangeEvents, publicDemoHoldings, publicDemoOverrides, publicDemoProducts } from "@/lib/public-demo";
import { accounts } from "@/lib/seed-data";
import { bestAvailableFirstTierProduct, maximumShortTermDays, minimumOpportunityApr, productHasKnownCapacity, totalHighYieldRemaining } from "@/lib/opportunity-policy";
import { buildManualChangeEvents, sameManualProduct } from "@/lib/product-change-events";
import { createLocalProductHistoryPreviewLoader } from "@/lib/product-history-preview";
import { userProductInputToProduct } from "@/lib/user-products";
import { hasCompletePurchaseTiming, summarizeHoldingTiming } from "@/lib/holding-timing";

type ApiResult = {
  dailyRefreshPending?: boolean;
  products?: Product[];
  rates: Array<{
    productId: string;
    name?: string;
    apr: number;
    tierAprs?: number[];
    tiers?: Array<{ min: number; max: number | null; apr: number }>;
    fetchedAt: string;
    sourceLabel: string;
    productType?: "flexible" | "fixed";
    termDays?: number;
    minimumAmount?: number;
    subscriptionStartsAt?: string;
    subscriptionEndsAt?: string;
    availability?: Product["availability"];
    eligibilityRequired?: boolean;
    eligibilityLabel?: string;
    eligibilityStatus?: Product["eligibilityStatus"];
    rateCoverage?: Product["rateCoverage"];
    aprSource?: Product["aprSource"];
    aprFetchedAt?: string;
    capacitySource?: Product["capacitySource"];
    capacityFetchedAt?: string;
    externalProductId?: string;
    identityKey?: string;
  }>;
  rateFallbacks?: Record<string, string>;
  holdingUpdates?: HoldingMap;
  holdingSourceIds?: string[];
  holdingFallbacks?: Record<string, string>;
  holdingSyncStates?: Record<string, HoldingSyncState>;
  holdingPositions?: HoldingPosition[];
  apiFieldNotices?: Array<{ accountId: string; asset: Asset; productName: string; externalProductId?: string; fields: string[] }>;
  changeEvents?: ProductChangeEvent[];
  partial: boolean;
  note: string;
  fetchedAt?: string;
  fallbackUpdatedAt?: string | null;
  identityChanges?: Record<string, { state: "new" | "unchanged" | "changed"; previousKey?: string; currentKey?: string }>;
  failures?: string[];
  cache?: {
    state: "fresh" | "updated" | "stale" | "syncing" | "cooldown" | "error";
    updatedAt: string | null;
    expiresAt: string | null;
    cooldownUntil: string | null;
    lastAttemptAt: string | null;
    lastError: string | null;
    scheduledAt?: string | null;
    scheduledState?: "scheduled" | "syncing" | "overdue" | "disabled";
  };
};
type HoldingsApiResult = { products?: Product[]; holdings: HoldingMap; overrides: ProductOverrideMap; manualProducts: Product[]; hiddenProductIds?: string[]; found: boolean };
type PortfolioChanges = {
  holdingProductIds: string[];
  overrideProductIds: string[];
  manualProductIds: string[];
  deletedManualProductIds: string[];
  hiddenProductIds?: string[];
  source?: ProductChangeEvent["source"];
};
const emptyHoldings: HoldingMap = {};

export function Dashboard({ mode, localPreview = false, initialAsset }: { mode: "demo" | "private"; localPreview?: boolean; initialAsset?: Asset }) {
  const router = useRouter();
  const isDemo = mode === "demo";
  const [asset, setAsset] = useState<Asset>(() => {
    if (initialAsset) return initialAsset;
    if (typeof window === "undefined") return "USDT";
    const value = new URLSearchParams(window.location.search).get("asset")?.toUpperCase();
    return value === "USDT" || value === "USDC" || value === "USDGO" || value === "BTC" ? value : "USDT";
  });
  // Private products come from the account-scoped catalogue. Keep the initial
  // state empty so a new account never briefly falls back to the global seed
  // directory while its catalogue is loading.
  const [products, setProducts] = useState(() => isDemo ? publicDemoProducts : []);
  const [manualProducts, setManualProducts] = useState<Product[]>([]);
  const [holdings, setHoldings] = useState<HoldingMap>(isDemo ? publicDemoHoldings : emptyHoldings);
  const [productOverrides, setProductOverrides] = useState<ProductOverrideMap>(isDemo ? publicDemoOverrides : {});
  const [holdingsReady, setHoldingsReady] = useState(isDemo);
  const [personalDataError, setPersonalDataError] = useState(false);
  const [personalDataLoading, setPersonalDataLoading] = useState(false);
  const personalDataReadyRef = useRef(isDemo);
  const personalDataLoadingRef = useRef(false);
  const [editing, setEditing] = useState(false);
  const [draftHoldings, setDraftHoldings] = useState<HoldingMap>(emptyHoldings);
  const [draftOverrides, setDraftOverrides] = useState<ProductOverrideMap>({});
  const [draftManualProducts, setDraftManualProducts] = useState<Product[]>([]);
  const [deletedManualProductIds, setDeletedManualProductIds] = useState<string[]>([]);
  const [hiddenProductIds, setHiddenProductIds] = useState<string[]>([]);
  const [draftHiddenProductIds, setDraftHiddenProductIds] = useState<string[]>([]);
  const [showAssetSwitchWarning, setShowAssetSwitchWarning] = useState(false);
  const [pendingAsset, setPendingAsset] = useState<Asset | null>(null);
  const [pendingDeleteProductId, setPendingDeleteProductId] = useState<string | null>(null);
  const [savingHoldings, setSavingHoldings] = useState(false);
  const [holdingSaveError, setHoldingSaveError] = useState(false);
  const [rateFallbacks, setRateFallbacks] = useState<Record<string, string>>({});
  const [apiHoldingProductIds, setApiHoldingProductIds] = useState<Set<string>>(() => new Set());
  const [holdingFallbacks, setHoldingFallbacks] = useState<Record<string, string>>({});
  const [holdingSyncStates, setHoldingSyncStates] = useState<ApiResult["holdingSyncStates"]>({});
  const [holdingPositions, setHoldingPositions] = useState<HoldingPosition[]>([]);
  const [changeEvents, setChangeEvents] = useState<ProductChangeEvent[]>(() => isDemo ? publicDemoChangeEvents : []);
  const [showApiSettings, setShowApiSettings] = useState(false);
  const [apiSettingsMounted, setApiSettingsMounted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasSyncFailure, setHasSyncFailure] = useState(false);
  const [syncFailures, setSyncFailures] = useState<string[]>([]);
  const [apiFieldNotices, setApiFieldNotices] = useState<NonNullable<ApiResult["apiFieldNotices"]>>([]);
  const [syncing, setSyncing] = useState(false);
  const [refreshingExchange, setRefreshingExchange] = useState(false);
  const [manualRefreshInProgress, setManualRefreshInProgress] = useState(false);
  const [preserveManualRefreshButton, setPreserveManualRefreshButton] = useState(false);
  const [syncCache, setSyncCache] = useState<ApiResult["cache"]>();
  const [productSnapshotReady, setProductSnapshotReady] = useState(false);
  const [openingLoading, setOpeningLoading] = useState(!isDemo);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [manualRefreshAvailableAt, setManualRefreshAvailableAt] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const dailyRefreshPendingRef = useRef(!isDemo && !localPreview);
  const refreshInFlightRef = useRef(false);
  const manualRefreshInFlightRef = useRef(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const productOverridesRef = useRef<ProductOverrideMap>({});
  const manualProductsRef = useRef<Product[]>([]);
  const hiddenProductIdsRef = useRef<string[]>([]);
  const holdingsRef = useRef<HoldingMap>(holdings);
  const previewScenario = localPreview && typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("syncScenario") : null;
  const historyPreviewLoader = useMemo(() => localPreview ? createLocalProductHistoryPreviewLoader() : null, [localPreview]);
  const previewAt = localPreview && typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("previewAt") : null;
  const previewQuery = localPreview ? `?preview=1${previewScenario ? `&syncScenario=${encodeURIComponent(previewScenario)}` : ""}${previewAt ? `&previewAt=${encodeURIComponent(previewAt)}` : ""}` : "";
  const holdingsEndpoint = `/private/api/holdings${previewQuery}`;
  const productsEndpoint = `/private/api/products${previewQuery}`;
  function refreshEndpoint(manual = false) {
    const daily = !manual && dailyRefreshPendingRef.current;
    const flag = manual ? "refresh=1" : daily ? "visit=1" : "";
    const url = flag ? `${productsEndpoint}${productsEndpoint.includes("?") ? "&" : "?"}${flag}` : productsEndpoint;
    return { url, method: manual || daily ? "POST" as const : "GET" as const };
  }

  function openPrivateDashboard() {
    router.push(`/private?asset=${encodeURIComponent(asset)}`);
  }

  function openApiSettings() {
    setApiSettingsMounted(true);
    setShowApiSettings(true);
  }

  function openPrivateApiSettings() {
    router.push(`/private?asset=${encodeURIComponent(asset)}&settings=api`);
  }

  useEffect(() => {
    const url = new URL(window.location.href);
    if (asset === "USDT") url.searchParams.delete("asset");
    else url.searchParams.set("asset", asset);
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, [asset]);

  useEffect(() => {
    if (isDemo) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("settings") !== "api") return;
    url.searchParams.delete("settings");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    const openTimer = window.setTimeout(() => {
      setApiSettingsMounted(true);
      setShowApiSettings(true);
    }, 0);
    return () => window.clearTimeout(openTimer);
  }, [isDemo]);

  useEffect(() => { productOverridesRef.current = productOverrides; }, [productOverrides]);
  useEffect(() => { manualProductsRef.current = manualProducts; }, [manualProducts]);
  useEffect(() => { hiddenProductIdsRef.current = hiddenProductIds; }, [hiddenProductIds]);
  useEffect(() => { holdingsRef.current = holdings; }, [holdings]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  async function loadPersonalData(): Promise<HoldingMap | null> {
    setPersonalDataLoading(true);
    reportStartupDiagnostic("holdings", "持仓数据接口", "请求中");
    let responseStatus: number | null = null;
    try {
      const response = await fetch(holdingsEndpoint, { cache: "no-store" });
      responseStatus = response.status;
      reportStartupDiagnostic("holdings", "持仓数据接口", `HTTP ${response.status}`);
      if (!response.ok) throw new Error("cloud holdings unavailable");
      const data = await response.json() as HoldingsApiResult;
      reportStartupDiagnostic("holdings", "持仓数据接口", "响应已读取");
      if (data.products) setProducts(data.products);
      setProductOverrides(data.overrides ?? {});
      setManualProducts(data.manualProducts ?? []);
      const hiddenIds = data.hiddenProductIds ?? [];
      setHiddenProductIds(hiddenIds);
      productOverridesRef.current = data.overrides ?? {};
      manualProductsRef.current = data.manualProducts ?? [];
      hiddenProductIdsRef.current = hiddenIds;
      const next = { ...emptyHoldings, ...data.holdings };
      setHoldings(next);
      holdingsRef.current = next;
      personalDataReadyRef.current = true;
      setPersonalDataError(false);
      return next;
    } catch {
      reportStartupDiagnostic("holdings", "持仓数据接口", responseStatus === null ? "网络请求失败" : `HTTP ${responseStatus}，响应读取失败`);
      // A failed read is not an empty portfolio. Keep any existing data.
      personalDataReadyRef.current = false;
      setPersonalDataError(true);
      return null;
    } finally {
      setPersonalDataLoading(false);
    }
  }

  async function retryPersonalData() {
    if (personalDataLoadingRef.current) return;
    personalDataLoadingRef.current = true;
    setOpeningLoading(true);
    try {
      const loaded = await loadPersonalData();
      if (loaded === null) return;
      setHoldingsReady(true);
      await refreshRates(loaded, { cacheOnly: true });
      if (dailyRefreshPendingRef.current) await refreshRates(holdingsRef.current);
    } finally {
      personalDataLoadingRef.current = false;
      setOpeningLoading(false);
    }
  }

  useEffect(() => {
    async function initialize() {
      if (isDemo) {
        setHoldings(publicDemoHoldings);
        setProductOverrides(publicDemoOverrides);
        setHoldingsReady(true);
        return;
      }
      void fetch("/private/api/session", { cache: "no-store" })
        .then((response) => {
          reportStartupDiagnostic("session", "登录状态接口", `HTTP ${response.status}`);
          return response.ok ? response.json() as Promise<{ email: string }> : Promise.reject();
        })
        .then((session) => setUserEmail(session.email))
        .catch(() => {
          reportStartupDiagnostic("session-error", "登录状态读取", "网络或响应读取失败");
          setUserEmail(null);
        });
      reportStartupDiagnostic("initialization", "页面初始化", "已开始");
      setLoading(true);
      // Show the saved snapshot before requesting today's opening refresh.
      const productsResponse = fetch(productsEndpoint, { cache: "no-store" });
      void productsResponse.then((response) => {
        reportStartupDiagnostic("products-http", "产品数据接口", `HTTP ${response.status}`);
      }).catch(() => {
        reportStartupDiagnostic("products-error", "产品数据请求", "网络请求失败");
      });
      personalDataLoadingRef.current = true;
      try {
        const loaded = await loadPersonalData();
        setHoldingsReady(loaded !== null);
        await refreshRates(loaded ?? holdingsRef.current, { response: productsResponse, cacheOnly: true });
        // An unreadable cache does not consume or cancel today's exchange attempt.
        if (dailyRefreshPendingRef.current) await refreshRates(holdingsRef.current);
      } finally {
        personalDataLoadingRef.current = false;
        setOpeningLoading(false);
        reportStartupDiagnostic("initialization", "页面初始化", "首轮读取已结束");
      }
    }

    const frame = window.requestAnimationFrame(() => void initialize());
    return () => {
      window.cancelAnimationFrame(frame);
    };
    // Initial load intentionally runs once for each fixed dashboard mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshRates(baseHoldings: HoldingMap = holdings, options?: { manual?: boolean; response?: Promise<Response>; silent?: boolean; cacheOnly?: boolean }) {
    if (refreshInFlightRef.current) return false;
    refreshInFlightRef.current = true;
    const refreshingDaily = !options?.manual && !options?.cacheOnly && dailyRefreshPendingRef.current;
    if (!options?.silent) setLoading(true);
    if (options?.manual || refreshingDaily) setRefreshingExchange(true);
    try {
      const endpoint = options?.cacheOnly ? { url: productsEndpoint, method: "GET" as const } : refreshEndpoint(options?.manual);
      const response = await (options?.response ?? fetch(endpoint.url, { method: endpoint.method, cache: "no-store" }));
      reportStartupDiagnostic("rate-data", "产品与同步接口", `HTTP ${response.status}`);
      if (!response.ok) {
        const errorData = await response.json().catch(() => null) as Pick<ApiResult, "cache" | "dailyRefreshPending"> | null;
        if (!options?.manual && !options?.cacheOnly) dailyRefreshPendingRef.current = errorData?.dailyRefreshPending === true;
        if (errorData?.cache?.state === "error") {
          setProductSnapshotReady(true);
          setSyncCache(errorData.cache);
          setSyncing(false);
          setHasSyncFailure(true);
          setSyncFailures(["产品和持仓数据更新失败"]);
          setLastUpdated(errorData.cache.updatedAt);
          setManualRefreshAvailableAt(errorData.cache.cooldownUntil);
          setClock(Date.now());
          return true;
        }
        throw new Error("rate refresh failed");
      }
      const data = await response.json() as ApiResult;
      reportStartupDiagnostic("rate-data", "产品与同步接口", "响应已读取");
      if (!options?.manual && !options?.cacheOnly) dailyRefreshPendingRef.current = data.dailyRefreshPending === true;
      setProductSnapshotReady(true);
      setSyncCache(data.cache);
      const hardFailure = data.cache?.state === "stale" || data.cache?.state === "error";
      const failures = data.failures?.filter(Boolean) ?? [];
      setSyncing(data.cache?.state === "syncing");
      setHasSyncFailure(hardFailure || data.partial || failures.length > 0);
      setSyncFailures(failures);
      setApiFieldNotices(data.apiFieldNotices ?? []);
      setRateFallbacks(data.rateFallbacks ?? {});
      setApiHoldingProductIds(new Set(data.holdingSourceIds ?? Object.keys(data.holdingUpdates ?? {})));
      setHoldingFallbacks(data.holdingFallbacks ?? {});
      setHoldingSyncStates(data.holdingSyncStates ?? {});
      setHoldingPositions(data.holdingPositions ?? []);
      setChangeEvents(data.changeEvents ?? []);
      // The API response is authoritative. An empty list means this account
      // has no discovered products yet; do not repopulate the old global seed
      // directory on the client.
      const nextProducts: Product[] = data.products ?? [];
      setProducts(nextProducts);
      const positivePositionIds = new Set((data.holdingPositions ?? [])
        .filter((position) => Number(position.amount) > 0)
        .map((position) => position.productId));
      const nextHiddenProductIds = hiddenProductIdsRef.current.filter((productId) => (
        Number(data.holdingUpdates?.[productId] ?? 0) <= 0 && !positivePositionIds.has(productId)
      ));
      if (nextHiddenProductIds.length !== hiddenProductIdsRef.current.length) {
        hiddenProductIdsRef.current = nextHiddenProductIds;
        setHiddenProductIds(nextHiddenProductIds);
      }
      const acceptedHoldingUpdates = Object.fromEntries(Object.entries(data.holdingUpdates ?? {}).filter(([productId]) => (
        nextProducts.find((product) => product.id === productId)?.holdingDataMode === "api"
        && !nextHiddenProductIds.includes(productId)
      )));
      if (!isDemo && Object.keys(acceptedHoldingUpdates).length > 0) {
        const next = { ...baseHoldings, ...acceptedHoldingUpdates };
        setHoldings(next);
        holdingsRef.current = next;
      }
      const updatedAt = data.cache?.updatedAt
        ?? data.fetchedAt
        ?? data.rates.reduce<string | null>((latest, rate) => !latest || rate.fetchedAt > latest ? rate.fetchedAt : latest, null);
      setLastUpdated(updatedAt);
      setManualRefreshAvailableAt(data.cache?.cooldownUntil ?? null);
      setClock(Date.now());
      return true;
    } catch {
      reportStartupDiagnostic("rate-data", "产品与同步接口", "请求或响应读取失败");
      // A network/read failure does not start a repeating exchange retry loop.
      if (!options?.manual && !options?.cacheOnly) dailyRefreshPendingRef.current = false;
      setSyncing(false);
      if (!options?.silent) {
        setHasSyncFailure(true);
        setSyncFailures(["页面数据读取失败"]);
      }
      return false;
    } finally {
      refreshInFlightRef.current = false;
      setRefreshingExchange(false);
      if (!options?.silent) setLoading(false);
    }
  }

  useEffect(() => {
    // Keep polling even when the first request failed and there is no cache
    // timestamp yet; a later scheduled refresh should appear without reload.
    if (isDemo || editing || openingLoading || (!holdingsReady && !dailyRefreshPendingRef.current)) return;
    const timer = window.setInterval(() => {
      if (!personalDataReadyRef.current && !dailyRefreshPendingRef.current) return;
      void refreshRates(holdingsRef.current, { silent: true });
    }, 60_000);
    return () => window.clearInterval(timer);
    // Polls only read cache once this opening's daily refresh has been handled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, holdingsReady, isDemo, openingLoading, productsEndpoint]);

  async function persistPortfolio(next: HoldingMap, overrides: ProductOverrideMap, nextManualProducts: Product[], changes: PortfolioChanges) {
    const manualProductIds = new Set(changes.manualProductIds);
    const response = await fetch(holdingsEndpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        holdings: Object.fromEntries(changes.holdingProductIds.map((productId) => [productId, next[productId] ?? 0])),
        overrides: Object.fromEntries(changes.overrideProductIds.map((productId) => [productId, overrides[productId]])),
        changedHoldingProductIds: changes.holdingProductIds,
        changedOverrideProductIds: changes.overrideProductIds,
        manualProducts: nextManualProducts.filter((product) => manualProductIds.has(product.id)).map(manualProductPayload),
        deletedManualProductIds: changes.deletedManualProductIds,
        source: changes.source,
        ...(changes.hiddenProductIds ? { hiddenProductIds: changes.hiddenProductIds } : {}),
      }),
    });
    if (!response.ok) throw new Error("cloud save failed");
    return response.json() as Promise<{ updatedAt: string; changeEvents?: ProductChangeEvent[] }>;
  }

  async function savePortfolio(nextHoldings: HoldingMap, nextOverrides: ProductOverrideMap, nextManualProducts: Product[], nextHiddenProductIds: string[], changes: PortfolioChanges) {
    const previousHoldings = holdings;
    const previousOverrides = productOverrides;
    const previousManualProducts = manualProducts;
    const previousHiddenProductIds = hiddenProductIds;
    setHoldings(nextHoldings);
    setProductOverrides(nextOverrides);
    setManualProducts(nextManualProducts);
    setHiddenProductIds(nextHiddenProductIds);
    hiddenProductIdsRef.current = nextHiddenProductIds;
    try {
      const result = await persistPortfolio(nextHoldings, nextOverrides, nextManualProducts, changes);
      setProductOverrides((current) => ({
        ...current,
        ...Object.fromEntries(changes.overrideProductIds.map((productId) => [productId, {
          apr: current[productId]?.apr ?? null,
          firstTierLimit: current[productId]?.firstTierLimit ?? null,
          termDays: current[productId]?.termDays ?? null,
          purchaseDate: current[productId]?.purchaseDate ?? null,
          updatedAt: result.updatedAt,
        }])),
      }));
      if (!isDemo) setChangeEvents(result.changeEvents ?? []);
      return true;
    } catch {
      setHoldings(previousHoldings);
      setProductOverrides(previousOverrides);
      setManualProducts(previousManualProducts);
      setHiddenProductIds(previousHiddenProductIds);
      hiddenProductIdsRef.current = previousHiddenProductIds;
      return false;
    }
  }

  function beginEditing() {
    if (!canEdit) return;
    setDraftHoldings({ ...holdings });
    setDraftOverrides(structuredClone(productOverrides));
    setDraftManualProducts(structuredClone(manualProducts));
    setDraftHiddenProductIds([...hiddenProductIds]);
    setDeletedManualProductIds([]);
    setPendingDeleteProductId(null);
    setHoldingSaveError(false);
    setEditing(true);
  }

  function cancelEditing() {
    if (savingHoldings) return;
    setDraftHoldings({ ...holdings });
    setDraftOverrides(structuredClone(productOverrides));
    setDraftManualProducts(structuredClone(manualProducts));
    setDraftHiddenProductIds([...hiddenProductIds]);
    setDeletedManualProductIds([]);
    setPendingDeleteProductId(null);
    setHoldingSaveError(false);
    setEditing(false);
  }

  function updateDraftOverride(productId: string, patch: Partial<ProductOverride>) {
    setDraftOverrides((current) => ({
      ...current,
      [productId]: {
        apr: current[productId]?.apr ?? productOverrides[productId]?.apr ?? null,
        firstTierLimit: current[productId]?.firstTierLimit ?? productOverrides[productId]?.firstTierLimit ?? null,
        termDays: current[productId]?.termDays ?? productOverrides[productId]?.termDays ?? null,
        purchaseDate: current[productId]?.purchaseDate ?? productOverrides[productId]?.purchaseDate ?? null,
        updatedAt: current[productId]?.updatedAt ?? productOverrides[productId]?.updatedAt ?? null,
        ...patch,
      },
    }));
  }

  function addManualProduct() {
    const id = `manual-${crypto.randomUUID()}`;
    const account = accounts.find((candidate) => candidate.id === "binance-bahrain") ?? accounts[0];
    const product = userProductInputToProduct({
      id,
      accountId: account.id,
      asset,
      manualKind: "flexible",
      termDays: null,
    });
    setDraftManualProducts((current) => [...current, product]);
    setDraftHoldings((current) => ({ ...current, [id]: 0 }));
    setDraftOverrides((current) => ({ ...current, [id]: { apr: null, firstTierLimit: null, termDays: null, purchaseDate: null, updatedAt: null } }));
  }

  function updateDraftManualProduct(productId: string, patch: ManualProductPatch) {
    setDraftManualProducts((current) => current.map((product) => {
      if (product.id !== productId) return product;
      if (product.productDataMode !== "manual") return product;
      const next = { ...product, ...patch };
      const account = accounts.find((candidate) => candidate.id === next.accountId) ?? accounts[0];
      const kind = next.manualKind ?? "flexible";
      return userProductInputToProduct({
        id: next.id,
        accountId: account.id,
        asset: next.asset,
        manualKind: kind,
        termDays: kind === "flexible" ? null : next.termDays ?? null,
      });
    }));
  }

  function deleteDraftProduct(productId: string) {
    const userProduct = draftManualProducts.some((product) => product.id === productId);
    if (userProduct) setDraftManualProducts((current) => current.filter((product) => product.id !== productId));
    else {
      const listedProduct = products.find((product) => product.id === productId);
      if (!listedProduct) return;
      setDraftHiddenProductIds((current) => [...new Set([...current, productId])]);
    }
    setDraftHoldings((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== productId)) as HoldingMap);
    setDraftOverrides((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== productId)) as ProductOverrideMap);
    if (manualProducts.some((product) => product.id === productId)) {
      setDeletedManualProductIds((current) => [...new Set([...current, productId])]);
    }
    setPendingDeleteProductId(null);
  }

  async function finishEditing() {
    const hiddenProductIdSet = new Set(draftHiddenProductIds);
    const workingProducts = [...products.filter((product) => !hiddenProductIdSet.has(product.id)), ...draftManualProducts];
    const holdingProductIds = workingProducts.flatMap((product) => (
      (draftHoldings[product.id] ?? 0) !== (holdings[product.id] ?? 0) ? [product.id] : []
    ));
    const overrideProductIds = workingProducts.flatMap((product) => (
      !sameOverride(draftOverrides[product.id], productOverrides[product.id]) ? [product.id] : []
    ));
    const manualProductIds = workingProducts.flatMap((product) => (
      product.id.startsWith("manual-") && !sameManualProduct(product, manualProducts.find((item) => item.id === product.id)) ? [product.id] : []
    ));
    const hiddenProductsChanged = !sameIdSet(draftHiddenProductIds, hiddenProductIds);
    if (holdingProductIds.length === 0 && overrideProductIds.length === 0 && manualProductIds.length === 0 && deletedManualProductIds.length === 0 && !hiddenProductsChanged) {
      setEditing(false);
      return true;
    }
    if (isDemo) {
      setHoldings(draftHoldings);
      setProductOverrides(draftOverrides);
      setManualProducts(draftManualProducts);
      setHiddenProductIds(draftHiddenProductIds);
      hiddenProductIdsRef.current = draftHiddenProductIds;
      setChangeEvents((current) => [...buildManualChangeEvents(holdings, draftHoldings, productOverrides, draftOverrides, manualProducts, draftManualProducts, products, {
        holdingProductIds,
        overrideProductIds,
        manualProductIds,
        deletedManualProductIds,
      }), ...current]);
      setDeletedManualProductIds([]);
      setEditing(false);
      return true;
    }
    setSavingHoldings(true);
    setHoldingSaveError(false);
    const saved = await savePortfolio(draftHoldings, draftOverrides, draftManualProducts, draftHiddenProductIds, {
      holdingProductIds,
      overrideProductIds,
      manualProductIds,
      deletedManualProductIds,
      source: "手动编辑",
      ...(hiddenProductsChanged ? { hiddenProductIds: draftHiddenProductIds } : {}),
    });
    setSavingHoldings(false);
    if (saved) {
      if (localPreview) {
        setChangeEvents((current) => [...buildManualChangeEvents(holdings, draftHoldings, productOverrides, draftOverrides, manualProducts, draftManualProducts, products, {
          holdingProductIds,
          overrideProductIds,
          manualProductIds,
          deletedManualProductIds,
        }), ...current]);
      }
      setEditing(false);
    }
    else setHoldingSaveError(true);
    return saved;
  }

  async function saveAndLeaveAssetSwitch() {
    if (!pendingAsset || savingHoldings) return;
    const nextAsset = pendingAsset;
    const saved = await finishEditing();
    if (!saved) return;
    setPendingAsset(null);
    setShowAssetSwitchWarning(false);
    setAsset(nextAsset);
  }

  const activeHoldings = editing ? draftHoldings : holdings;
  const activeOverrides = editing ? draftOverrides : productOverrides;
  const activeManualProducts = editing ? draftManualProducts : manualProducts;
  const activeHiddenProductIds = editing ? draftHiddenProductIds : hiddenProductIds;
  const activeBaseProducts = useMemo(() => {
    const hiddenIds = new Set(activeHiddenProductIds);
    return [...products.filter((product) => !hiddenIds.has(product.id)), ...(editing ? draftManualProducts : manualProducts)];
  }, [activeHiddenProductIds, draftManualProducts, editing, manualProducts, products]);
  const resolvedProducts = useMemo(() => activeBaseProducts.map((product) => applyProductOverride(product, activeOverrides[product.id])), [activeBaseProducts, activeOverrides]);
  const holdingIsKnown = (product: Product) => isDemo || product.holdingDataMode === "manual" || apiHoldingProductIds.has(product.id);
  const assetProducts = useMemo(() => resolvedProducts
    .filter((product) => product.asset === asset)
    .sort((left, right) => {
      const leftIsNew = editing && left.id.startsWith("manual-") && !manualProducts.some((product) => product.id === left.id);
      const rightIsNew = editing && right.id.startsWith("manual-") && !manualProducts.some((product) => product.id === right.id);
      if (leftIsNew !== rightIsNew) return leftIsNew ? -1 : 1;
      return left.exchange.localeCompare(right.exchange, "en", { sensitivity: "base" })
      || left.region.localeCompare(right.region, "en", { sensitivity: "base" })
      || left.name.localeCompare(right.name, "en", { sensitivity: "base" });
    }), [asset, editing, manualProducts, resolvedProducts]);
  const tableProducts = assetProducts;
  const holdingTimingByProduct = useMemo(() => {
    const grouped = new Map<string, HoldingPosition[]>();
    for (const position of holdingPositions) {
      const current = grouped.get(position.productId) ?? [];
      current.push(position);
      grouped.set(position.productId, current);
    }
    return new Map([...grouped].map(([productId, positions]) => [productId, summarizeHoldingTiming(positions)]));
  }, [holdingPositions]);
  const positivePositionProductIds = useMemo(() => new Set(
    holdingPositions.filter((position) => Number(position.amount) > 0).map((position) => position.productId),
  ), [holdingPositions]);
  const totalHolding = assetProducts.reduce((sum, product) => holdingIsKnown(product) ? sum + (activeHoldings[product.id] ?? 0) : sum, 0);
  const calculableProducts = assetProducts.filter((product) => holdingIsKnown(product) && productParticipatesInInterest(product, activeHoldings[product.id] ?? 0, activeOverrides[product.id], hasCompletePurchaseTiming(holdingTimingByProduct.get(product.id), activeHoldings[product.id] ?? 0)));
  const calculableHolding = calculableProducts.reduce((sum, product) => sum + (activeHoldings[product.id] ?? 0), 0);
  const annualEarn = calculableProducts.reduce((sum, product) => sum + (activeHoldings[product.id] ?? 0) * effectiveApr(product, activeHoldings[product.id] ?? 0) / 100, 0);
  const portfolioApr = calculableHolding ? annualEarn / calculableHolding * 100 : 0;
  const bestProduct = bestAvailableFirstTierProduct(assetProducts, activeHoldings, holdingIsKnown, clock);
  const highYieldLeft = totalHighYieldRemaining(assetProducts, activeHoldings, holdingIsKnown, clock);
  const tierOneOverflow = assetProducts.reduce((sum, product) => holdingIsKnown(product) && productHasKnownCapacity(product)
    ? sum + overflowFromFirstTier(product, activeHoldings[product.id] ?? 0)
    : sum, 0);
  const holdingProductCount = assetProducts.filter((product) => holdingIsKnown(product) && (activeHoldings[product.id] ?? 0) > 0).length;
  const missingApiFieldNotices = (isDemo ? [] : resolvedProducts).flatMap((product) => {
    const issues = productInformationIssues(product, activeOverrides[product.id],
      hasCompletePurchaseTiming(holdingTimingByProduct.get(product.id), activeHoldings[product.id] ?? 0),
      holdingIsKnown(product) && (activeHoldings[product.id] ?? 0) > 0)
      .filter((issue) => issue.endsWith("未获取"));
    return issues.length ? [`${accountName(product.accountId)} · ${product.asset} ${product.name} · ${issues.join("、")}`] : [];
  }).concat((isDemo ? [] : apiFieldNotices).flatMap((notice) => {
    const visible = resolvedProducts.find((product) => product.accountId === notice.accountId
      && product.asset === notice.asset && product.externalProductId === notice.externalProductId);
    if (visible) {
      const visibleIssues = productInformationIssues(visible, activeOverrides[visible.id],
        hasCompletePurchaseTiming(holdingTimingByProduct.get(visible.id), activeHoldings[visible.id] ?? 0),
        holdingIsKnown(visible) && (activeHoldings[visible.id] ?? 0) > 0);
      if (notice.fields.every((field) => visibleIssues.includes(field as ProductInformationIssue))) return [];
    }
    return [`${accountName(notice.accountId)} · ${notice.asset} ${notice.productName} · ${notice.fields.join("、")}`];
  }));
  const uniqueMissingApiFieldNotices = [...new Set(missingApiFieldNotices)];
  const hasTopNotice = hasSyncFailure || uniqueMissingApiFieldNotices.length > 0;
  const manualRefreshCooling = Boolean(manualRefreshAvailableAt && Date.parse(manualRefreshAvailableAt) > clock);
  const pageReadFailed = syncFailures.includes("页面数据读取失败");
  const { updating, dataBlocked, initialLoading, canEdit } = dashboardReadState({
    isDemo, opening: openingLoading, requesting: loading || refreshingExchange,
    backgroundUpdating: localPreview ? syncing : scheduledRefreshPending(clock, syncCache),
    personalReady: holdingsReady, personalError: personalDataError,
    productReady: productSnapshotReady, productReadFailed: pageReadFailed, lastUpdated,
  });
  const scheduledState = syncCache?.scheduledState ?? (updating ? "syncing" : "scheduled");
  const scheduledSyncDisabled = scheduledState === "disabled";
  const automaticRefreshSummary = updating || scheduledState !== "scheduled" || !syncCache?.scheduledAt
    ? null
    : formatSyncDateTime(syncCache.scheduledAt);
  const scheduledRefreshFailed = !isDemo && !updating && scheduledState === "overdue";
  const scheduledFailureLabel = syncCache?.scheduledAt
    ? `${formatSyncDateTime(syncCache.scheduledAt)} 定时更新失败，下次更新将重试。`
    : "定时更新失败，下次更新将重试。";
  const currentDataSummary = dataBlocked ? "" : updating
    ? ""
    : localPreview
      ? lastUpdated
        ? completedDataSummary(formatSyncDateTime(lastUpdated), { scheduledRefreshFailed, scheduledSyncDisabled, nextRefresh: automaticRefreshSummary, hasSyncFailure: hasTopNotice })
        : hasSyncFailure ? "暂无成功测试数据，" : "暂无成功测试数据。"
    : isDemo
      ? "以下均为演示数据。"
      : lastUpdated
        ? completedDataSummary(formatSyncDateTime(lastUpdated), { scheduledRefreshFailed, scheduledSyncDisabled, nextRefresh: automaticRefreshSummary, hasSyncFailure: hasTopNotice })
        : scheduledRefreshFailed ? "" : hasSyncFailure ? "暂无成功数据，" : "暂无成功数据。";
  const failureSummary = syncFailureSummary(syncFailures);
  const showSyncFailureRefresh = (manualRefreshInProgress && preserveManualRefreshButton)
    || (!dataBlocked && !isDemo && !updating && !scheduledRefreshFailed && hasTopNotice);

  async function handleManualRefresh() {
    if (manualRefreshInFlightRef.current) return;
    manualRefreshInFlightRef.current = true;
    setPreserveManualRefreshButton(showSyncFailureRefresh);
    setManualRefreshInProgress(true);
    try {
      if (holdingsReady) await refreshRates(activeHoldings, { manual: true });
      else await retryPersonalData();
    } finally {
      manualRefreshInFlightRef.current = false;
      setPreserveManualRefreshButton(false);
      setManualRefreshInProgress(false);
    }
  }

  return (
    <main className="min-h-screen">
      <nav className="top-nav sticky top-0 z-20 px-5 backdrop-blur lg:px-10" aria-label="主导航">
        <div className="page-width mx-auto flex min-h-14 flex-wrap items-center gap-x-4 sm:flex-nowrap">
          <div className="flex items-center py-2"><p className="type-title font-semibold tracking-[-0.025em]">Stable Earn</p></div>
          <div className="order-3 h-11 w-full self-stretch sm:order-none sm:ml-8 sm:h-auto sm:w-auto"><AssetSwitch asset={asset} onChange={(nextAsset) => { if (nextAsset === asset) return; if (editing) { setPendingAsset(nextAsset); setShowAssetSwitchWarning(true); } else setAsset(nextAsset); }} /></div>
          <HeaderMenu
            userEmail={userEmail}
            demo={isDemo}
            loading={openingLoading || loading || personalDataLoading}
            manualRefreshCooling={manualRefreshCooling}
            cooldownUntil={manualRefreshAvailableAt}
            onManualRefresh={handleManualRefresh}
            onApiSettings={isDemo ? openPrivateApiSettings : openApiSettings}
          />
        </div>
      </nav>

      <div className="page-width mx-auto px-5 py-5 lg:px-10 lg:py-6">
        <div className="card type-caption mb-4 flex items-center justify-between gap-4 px-5 py-4" aria-live="polite">
          <div className="sync-notice-copy flex min-w-0 flex-1 items-start gap-2">
            <svg className="sync-notice-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
            {dataBlocked
              ? <p className="text-danger font-semibold">{serverReadFailureMessage}</p>
            : <p className="sync-notice-message min-w-0 flex-1 text-muted font-normal"><span className="text-secondary">{currentDataSummary}</span>{updating && <span className="text-secondary font-normal">数据正在更新中，请稍候。</span>}{scheduledRefreshFailed && <span className="text-danger font-semibold">{scheduledFailureLabel}</span>}{!updating && !scheduledRefreshFailed && hasSyncFailure && <span className="text-danger font-semibold">{failureSummary}</span>}{!updating && uniqueMissingApiFieldNotices.length > 0 && <span className="text-danger font-semibold">{hasSyncFailure && !scheduledRefreshFailed ? "；" : ""}{uniqueMissingApiFieldNotices.join("；")}</span>}</p>}
          </div>
          {showSyncFailureRefresh && <ActionButton size="small" className="shrink-0 sync-notice-refresh" aria-label={manualRefreshInProgress && preserveManualRefreshButton ? "正在刷新" : undefined} aria-busy={manualRefreshInProgress && preserveManualRefreshButton} disabled={openingLoading || loading || refreshingExchange || manualRefreshInProgress || manualRefreshCooling} onClick={handleManualRefresh}>
            {manualRefreshInProgress && preserveManualRefreshButton
              ? <span className="loading-spinner" aria-hidden="true" />
              : "手动刷新"}
          </ActionButton>}
          {isDemo && <ActionButton size="small" className="shrink-0" onClick={openPrivateDashboard}>登录查看我的数据</ActionButton>}
        </div>
        <section className="metrics-panel card mb-4 grid overflow-hidden sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6" aria-busy={initialLoading}>
          {initialLoading ? <>{Array.from({ length: 6 }, (_, index) => <MetricSkeleton key={index} highlight={index === 0} />)}</> : <>
            <Metric highlight label={`总持仓 · ${asset}`} value={dataBlocked ? "—" : formatAmount(totalHolding)} note={dataBlocked ? "— 个持仓产品" : `${holdingProductCount} 个持仓产品`} />
            <Metric label="组合有效 APR" value={dataBlocked ? "—" : `${portfolioApr.toFixed(2)}%`} note="按各阶梯实际占用加权" />
            <Metric label={`预计每日收益 · ${asset}`} value={dataBlocked ? "—" : formatAmount(annualEarn / 365)} note="含活期、定期" />
            <Metric label="最佳首档 APR" value={!dataBlocked && bestProduct ? `${bestProduct.tiers[0]!.apr.toFixed(2)}%` : "—"} note={dataBlocked ? "—" : bestProduct ? accountName(bestProduct.accountId) : "暂无可确认的首档"} />
            <Metric label="高息剩余额度" value={dataBlocked ? "—" : highYieldLeft === Number.POSITIVE_INFINITY ? "不限" : formatAmount(highYieldLeft)} note="APR ≥ 6% 各档已知剩余额度" />
            <Metric label="超出首档" value={dataBlocked ? "—" : formatAmount(tierOneOverflow)} valueTone={!dataBlocked && tierOneOverflow > 0 ? "danger" : "default"} note={dataBlocked ? "—" : tierOneOverflow > 0 ? "已进入次档" : "未超出首档"} />
          </>}
        </section>

        <section className="card overflow-hidden">
          <div className="table-toolbar">
            <div className="table-toolbar-copy">
              <h2 className="type-title font-semibold tracking-[-0.02em]">{asset} 持仓</h2>
              <p className="table-toolbar-subtitle text-muted type-caption">
                {editing
                  ? asset === "BTC"
                    ? <>仅展示已有持仓，或 APR ≥ {minimumOpportunityApr}% 的活期及 {maximumShortTermDays} 天内定期产品，去<ActionButton variant="text" className="button-text-inline-action" onClick={isDemo ? openPrivateApiSettings : openApiSettings}>配置 API</ActionButton></>
                    : <>仅展示持仓 &gt; 0.01，或 APR ≥ {minimumOpportunityApr}% 的活期及 {maximumShortTermDays} 天内定期产品，去<ActionButton variant="text" className="button-text-inline-action" onClick={isDemo ? openPrivateApiSettings : openApiSettings}>配置 API</ActionButton></>
                  : asset === "BTC"
                    ? `仅展示已有持仓，或 APR ≥ ${minimumOpportunityApr}% 的活期及 ${maximumShortTermDays} 天内定期产品`
                    : `仅展示持仓 > 0.01，或 APR ≥ ${minimumOpportunityApr}% 的活期及 ${maximumShortTermDays} 天内定期产品`}
              </p>
            </div>
            {editing
              ? <div key="editing-actions" className="table-toolbar-actions flex shrink-0 items-center gap-2"><ActionButton variant="secondary" onClick={cancelEditing} disabled={savingHoldings}>取消</ActionButton><ActionButton variant="secondary" onClick={addManualProduct} disabled={savingHoldings}>添加产品</ActionButton><ActionButton onClick={() => void finishEditing()} disabled={savingHoldings}>{savingHoldings ? "保存中…" : "保存持仓"}</ActionButton></div>
              : <div key="view-actions" className="table-toolbar-actions flex shrink-0 items-center gap-2"><ActionButton variant={isDemo ? "secondary" : "primary"} onClick={beginEditing} disabled={!canEdit}>编辑持仓</ActionButton></div>}
          </div>
          {holdingSaveError && <div className="table-error-panel error-panel type-caption font-normal">保存失败，请检查网络后重试；表格中的修改仍然保留。</div>}
          <div className="overflow-x-auto"><table className="product-table type-body" aria-busy={initialLoading}><colgroup><col className="product-table-col-platform" /><col className="product-table-col-rate" /><col className="product-table-col-holding" /><col className="product-table-col-effective" /><col className="product-table-col-history" /></colgroup><thead><tr><th>平台 / 产品</th><th>产品与 APR</th><th>持仓 / 额度使用</th><th>有效 APR</th><th>变更</th></tr></thead><tbody>{dataBlocked ? <tr><td colSpan={5}><EmptyProductState message={serverReadFailureMessage} /></td></tr> : initialLoading ? <ProductTableSkeleton /> : tableProducts.length > 0 ? tableProducts.map((listedProduct) => {
            const baseProduct = activeBaseProducts.find((product) => product.id === listedProduct.id) ?? listedProduct;
            const manualSettings = activeOverrides[listedProduct.id];
            const displayProduct = applyProductOverride(baseProduct, manualSettings);
            // Manual/API is a product property, not an ID naming convention.
            // This keeps migrated manual catalog rows removable as well.
            const isManualProduct = activeManualProducts.some((product) => product.id === baseProduct.id);
            const apiHoldingSource = !isDemo && apiHoldingProductIds.has(baseProduct.id);
            const holdingFromApi = baseProduct.holdingDataMode === "api" || apiHoldingSource;
            const apiDeleteBlocked = !holdingIsKnown(baseProduct)
              || (holdingSyncStates?.[listedProduct.id] !== undefined && holdingSyncStates[listedProduct.id] !== "synced")
              || (activeHoldings[listedProduct.id] ?? 0) > 0
              || positivePositionProductIds.has(listedProduct.id);
            const apiDeleteDisabledReason = !holdingIsKnown(baseProduct) || holdingSyncStates?.[listedProduct.id] === "error" || holdingSyncStates?.[listedProduct.id] === "partial"
              ? "暂时无法确认持仓，刷新成功后才能移除"
              : (activeHoldings[listedProduct.id] ?? 0) > 0 || positivePositionProductIds.has(listedProduct.id) ? "有持仓的产品不能移除" : undefined;
            const isHistoryPreviewProduct = historyPreviewLoader !== null && [
              "by-g-usdt-short-fixed",
              "preview-apr-six",
              "preview-below-threshold-held",
            ].includes(listedProduct.id);
            const loadHistoryPage = isHistoryPreviewProduct
              ? (cursor: string | null) => historyPreviewLoader(listedProduct.id, cursor)
              : isDemo || localPreview ? undefined : (cursor: string | null) => loadProductHistoryPage(listedProduct.id, cursor);
            return <ProductRow key={listedProduct.id} product={displayProduct} baseProduct={baseProduct} manualSettings={manualSettings} holdingTiming={holdingTimingByProduct.get(listedProduct.id)} holding={activeHoldings[listedProduct.id] ?? 0} holdingAvailable={holdingIsKnown(baseProduct)} holdingSyncState={holdingSyncStates?.[listedProduct.id]} editing={editing} editable={isDemo || (baseProduct.holdingDataMode === "manual" && !apiHoldingSource)} saving={savingHoldings} manualProduct={isManualProduct} apiDeleteDisabled={apiDeleteBlocked} apiDeleteDisabledReason={apiDeleteDisabledReason} rateFallbackAt={baseProduct.productDataMode === "api" ? rateFallbacks[listedProduct.id] : undefined} holdingFallbackAt={!isDemo && holdingFromApi ? holdingFallbacks[listedProduct.id] : undefined} changeEvents={changeEvents.filter((event) => event.productId === listedProduct.id)} loadHistoryPage={loadHistoryPage} readOnlyHistoryPreview={isHistoryPreviewProduct} onEventsRead={(readAt, eventIds) => {
              const readIds = new Set(eventIds);
              setChangeEvents((current) => current.map((event) => event.productId === listedProduct.id
                && event.attention && !event.readAt && readIds.has(event.id) ? { ...event, readAt } : event));
            }} onHoldingChange={(value) => setDraftHoldings((current) => ({ ...current, [listedProduct.id]: value }))} onOverrideChange={(patch) => updateDraftOverride(listedProduct.id, patch)} onManualProductChange={(patch) => updateDraftManualProduct(listedProduct.id, patch)} onDelete={() => setPendingDeleteProductId(listedProduct.id)} />;
          }) : <tr><td colSpan={5}><EmptyProductState /></td></tr>}</tbody></table></div>
        </section>

        <footer className="site-footer text-muted type-caption"><p>数据仅用于监控与比较，不构成投资建议。实际到账以平台账户为准。</p><a className="github-footer-link" href="https://github.com/noood/stable-earn" target="_blank" rel="noreferrer" aria-label="GitHub 源码仓库" title="GitHub 源码仓库"><Image src="/GitHub_Lockup_Black_Clearspace.svg" width={448} height={127} alt="" aria-hidden="true" /></a></footer>
      </div>

      {!isDemo && apiSettingsMounted && <ApiSettings open={showApiSettings} onClose={() => setShowApiSettings(false)} onCooldownChange={() => setManualRefreshAvailableAt(null)} onCredentialsRemoved={async () => { await loadPersonalData(); }} />}
      {showAssetSwitchWarning && <ModalFrame ariaLabel="请先完成编辑" title="请先完成编辑" onClose={() => { if (!savingHoldings) { setPendingAsset(null); setShowAssetSwitchWarning(false); } }}><p className="text-secondary type-body">请先完成当前编辑，再切换币种。</p><div className="mt-5 flex justify-end gap-2"><ActionButton variant="secondary" onClick={() => { if (savingHoldings) return; setPendingAsset(null); setShowAssetSwitchWarning(false); }} disabled={savingHoldings}>取消</ActionButton><ActionButton onClick={() => void saveAndLeaveAssetSwitch()} disabled={savingHoldings || !pendingAsset}>{savingHoldings ? "保存中…" : "保存并离开"}</ActionButton></div></ModalFrame>}
      {pendingDeleteProductId && (() => {
        const isManual = draftManualProducts.some((product) => product.id === pendingDeleteProductId);
        return <ModalFrame
          ariaLabel={isManual ? "移除手动产品" : "移除产品"}
          title={isManual ? "移除手动产品" : "移除产品"}
          onClose={() => setPendingDeleteProductId(null)}
        >
          <p className="text-secondary type-body">{isManual
            ? "移除该产品及其已保存的持仓和人工设置；产品变更记录仍会保留。"
            : "移除该产品，产品记录和变更历史会保留；之后检测到持仓时会再次显示。"}</p>
          <div className="mt-5 flex justify-end gap-2">
            <ActionButton variant="secondary" onClick={() => setPendingDeleteProductId(null)}>取消</ActionButton>
            <ActionButton variant="danger" onClick={() => deleteDraftProduct(pendingDeleteProductId)}>{isManual ? "移除手动产品" : "移除产品"}</ActionButton>
          </div>
        </ModalFrame>;
      })()}
    </main>
  );
}

function AssetSwitch({ asset, onChange }: { asset: Asset; onChange: (asset: Asset) => void }) {
  const assets: Asset[] = ["USDT", "USDC", "USDGO", "BTC"];
  return <div className="asset-switch inline-flex h-full w-fit max-w-full flex-nowrap items-stretch gap-1">{assets.map((item) => <button key={item} onClick={() => onChange(item)} aria-current={asset === item ? "page" : undefined} className={`type-label flex shrink-0 items-center gap-2 border-b-[3px] px-3 font-semibold transition-colors ${asset === item ? "border-[var(--brand)] text-[var(--brand)]" : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]"}`}><AssetIcon asset={item} /><span>{item}</span></button>)}</div>;
}

function AssetIcon({ asset }: { asset: Asset }) {
  const [bitcoinIconFailed, setBitcoinIconFailed] = useState(false);
  const bitcoinIconRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const image = bitcoinIconRef.current;
    if (asset === "BTC" && image?.complete && image.naturalWidth === 0) setBitcoinIconFailed(true);
  }, [asset]);
  if (asset === "USDT") return <svg className="asset-icon" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#009393" /><path fill="#fff" d="M8 7h16v4h-6v2.2c5 .3 8.4 1.3 8.4 2.7s-3.4 2.5-8.4 2.8V25h-4v-6.3c-5-.3-8.4-1.4-8.4-2.8s3.4-2.4 8.4-2.7V11H8V7Zm8 9.1c3.4 0 6-.3 7.1-.7-1.1-.4-3.7-.7-7.1-.7s-6 .3-7.1.7c1.1.4 3.7.7 7.1.7Z" /></svg>;
  if (asset === "USDC") return <svg className="asset-icon" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#2775CA" /><path fill="#fff" d="M17.2 7.2v2c2 .3 3.4 1.5 3.8 3.3l-2.6.6c-.3-1.1-1.1-1.7-2.4-1.7-1.4 0-2.2.6-2.2 1.5 0 .8.6 1.2 2.7 1.7 3.2.7 4.7 1.9 4.7 4.3 0 2.2-1.5 3.7-4 4.1v2h-2.3v-2c-2.4-.4-3.9-1.8-4.2-4l2.7-.5c.2 1.4 1.2 2.2 2.7 2.2 1.5 0 2.4-.6 2.4-1.6 0-.9-.7-1.3-2.8-1.8-3.1-.7-4.6-1.9-4.6-4.2 0-2 1.4-3.5 3.8-3.9v-2h2.3Z" /><path d="M9.1 8.7a10 10 0 0 0 0 14.6M22.9 8.7a10 10 0 0 1 0 14.6" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" /></svg>;
  if (asset === "USDGO") {
    // Keep the icon local so the asset switcher does not depend on a remote CDN.
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="asset-icon asset-icon-image" src="/usdgo.svg" alt="" aria-hidden="true" />;
  }
  if (bitcoinIconFailed) return <span className="asset-icon bitcoin-icon-fallback" aria-hidden="true">₿</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img ref={bitcoinIconRef} className="asset-icon asset-icon-image" src="/bitcoin.svg" alt="" aria-hidden="true" onError={() => setBitcoinIconFailed(true)} />;
}

function HeaderMenu({ userEmail, demo, loading, manualRefreshCooling, cooldownUntil, onManualRefresh, onApiSettings }: { userEmail: string | null; demo: boolean; loading: boolean; manualRefreshCooling: boolean; cooldownUntil: string | null; onManualRefresh: () => void; onApiSettings: () => void }) {
  const menuRef = useDismissibleDetails();
  const cooldownTime = cooldownUntil ? new Date(cooldownUntil).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : null;
  const refreshLabel = loading
    ? "正在刷新…"
    : <><span>手动刷新</span>{manualRefreshCooling && cooldownTime && <span className="menu-item-refresh-note">冷却至 {cooldownTime}</span>}</>;

  function closeMenu(event: React.MouseEvent<HTMLButtonElement>, action: () => void) {
    event.currentTarget.closest("details")?.removeAttribute("open");
    action();
  }

  return <div className="ml-auto flex items-center justify-end py-2"><details ref={menuRef} className="action-menu relative"><summary className="icon-button action-menu-trigger list-none" aria-label="更多操作"><span aria-hidden="true">⋯</span></summary><div className="surface-popover action-menu-popover">{userEmail && <div className="menu-account"><p className="menu-account-label">当前账号</p><p className="menu-account-value" title={userEmail}>{userEmail}</p></div>}{!demo && <button type="button" disabled={loading || manualRefreshCooling} onClick={(event) => closeMenu(event, onManualRefresh)} className="menu-item menu-item-refresh">{refreshLabel}</button>}<button type="button" onClick={(event) => closeMenu(event, onApiSettings)} className="menu-item menu-item-leading">API 设置</button>{!demo && <a href="/logout" className="menu-item menu-item-danger">退出登录</a>}</div></details></div>;
}

async function loadProductHistoryPage(productId: string, cursor: string | null): Promise<ProductHistoryPage> {
  const params = new URLSearchParams({ productId });
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`/private/api/product-history?${params}`, { cache: "no-store" });
  if (!response.ok) throw new Error("history page unavailable");
  return response.json() as Promise<ProductHistoryPage>;
}

function EmptyProductState({ message = "吸引人的稳定理财尚未出现！" }: { message?: string }) {
  return <div className="empty-product-state"><p className="text-muted type-label font-semibold">{message}</p></div>;
}

function ProductTableSkeleton() {
  const widths = ["72%", "84%", "90%", "48%", "30%"];
  return <>{Array.from({ length: 3 }, (_, row) => <tr key={row} className="product-row" aria-hidden="true">{widths.map((width, column) => <TableCell key={column}><span className="skeleton-block skeleton-table-line" style={{ width }} /></TableCell>)}</tr>)}</>;
}

function accountName(accountId: string) {
  const account = accounts.find((item) => item.id === accountId);
  if (!account) return accountId;
  return account.name;
}

function sameOverride(left?: ProductOverride, right?: ProductOverride) {
  return (left?.apr ?? null) === (right?.apr ?? null)
    && (left?.firstTierLimit ?? null) === (right?.firstTierLimit ?? null)
    && (left?.termDays ?? null) === (right?.termDays ?? null)
    && (left?.purchaseDate ?? null) === (right?.purchaseDate ?? null);
}

function sameIdSet(left: string[], right: string[]) {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function manualProductPayload(product: Product) {
  return {
    id: product.id,
    accountId: product.accountId,
    asset: product.asset,
    manualKind: product.manualKind ?? (product.productType === "fixed" ? "fixed" : "flexible"),
    termDays: product.termDays ?? null,
  };
}
