"use client";

import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { ApiSettings } from "@/app/components/api-settings";
import { useDismissibleDetails } from "@/app/components/use-dismissible-details";
import { AccountBadge, ActionButton, HoldingSummary, Metric, ModalFrame, TableCell } from "@/app/components/ui";
import { effectiveApr, formatAmount, remainingHighYield, type Account, type Asset, type HoldingMap, type HoldingSyncState, type Product } from "@/lib/domain";
import { applyProductOverride, formatShortDate, productNeedsManualApr, productNeedsManualLimit, productNeedsManualTerm, productNeedsPurchaseDate, productTermDays, productTermStatus, type ProductOverride, type ProductOverrideMap } from "@/lib/product-overrides";
import { holdingSyncNote, productCanBeRemoved, productInformationIssues, productInformationNote, productParticipatesInInterest } from "@/lib/product-status";
import { publicDemoHoldings, publicDemoOverrides, publicDemoProducts } from "@/lib/public-demo";
import { accounts, seedProducts } from "@/lib/seed-data";

type ApiResult = {
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
    subscriptionEndsAt?: string;
    eligibilityRequired?: boolean;
    eligibilityLabel?: string;
    eligibilityStatus?: Product["eligibilityStatus"];
    rateCoverage?: Product["rateCoverage"];
    externalProductId?: string;
    identityKey?: string;
    identityFingerprint?: string;
  }>;
  rateFallbacks?: Record<string, string>;
  holdingUpdates?: HoldingMap;
  holdingSourceIds?: string[];
  holdingFallbacks?: Record<string, string>;
  holdingSyncStates?: Record<string, HoldingSyncState>;
  partial: boolean;
  note: string;
  fetchedAt?: string;
  fallbackUpdatedAt?: string | null;
  identityChanges?: Record<string, { state: "new" | "unchanged" | "changed"; previousKey?: string; currentKey?: string }>;
  failures?: string[];
  cache?: {
    state: "fresh" | "updated" | "stale" | "cooldown" | "error";
    updatedAt: string | null;
    expiresAt: string | null;
    cooldownUntil: string | null;
    lastAttemptAt: string | null;
    lastError: string | null;
  };
};
type HoldingsApiResult = { products?: Product[]; holdings: HoldingMap; overrides: ProductOverrideMap; manualProducts: Product[]; hiddenProductIds?: string[]; hiddenSeedProductIds?: string[]; found: boolean };
type ManualProductPatch = { accountId?: string; manualKind?: Product["manualKind"]; termDays?: number };
const emptyHoldings = Object.fromEntries(seedProducts.map((product) => [product.id, 0])) as HoldingMap;
const minimumVisibleApr = 4;

export default function Home() { return <Dashboard mode="demo" />; }

export function Dashboard({ mode, localPreview = false }: { mode: "demo" | "private"; localPreview?: boolean }) {
  const isDemo = mode === "demo";
  const [asset, setAsset] = useState<Asset>("USDT");
  // Private products come from the account-scoped catalogue. Keep the initial
  // state empty so a new account never briefly falls back to the global seed
  // directory while its catalogue is loading.
  const [products, setProducts] = useState(() => isDemo ? publicDemoProducts : []);
  const [manualProducts, setManualProducts] = useState<Product[]>([]);
  const [holdings, setHoldings] = useState<HoldingMap>(isDemo ? publicDemoHoldings : emptyHoldings);
  const [productOverrides, setProductOverrides] = useState<ProductOverrideMap>(isDemo ? publicDemoOverrides : {});
  const [holdingsReady, setHoldingsReady] = useState(isDemo);
  const [editing, setEditing] = useState(false);
  const [draftHoldings, setDraftHoldings] = useState<HoldingMap>(emptyHoldings);
  const [draftOverrides, setDraftOverrides] = useState<ProductOverrideMap>({});
  const [draftManualProducts, setDraftManualProducts] = useState<Product[]>([]);
  const [deletedManualProductIds, setDeletedManualProductIds] = useState<string[]>([]);
  const [hiddenSeedProductIds, setHiddenSeedProductIds] = useState<string[]>([]);
  const [draftHiddenSeedProductIds, setDraftHiddenSeedProductIds] = useState<string[]>([]);
  const [showAssetSwitchWarning, setShowAssetSwitchWarning] = useState(false);
  const [savingHoldings, setSavingHoldings] = useState(false);
  const [holdingSaveError, setHoldingSaveError] = useState(false);
  const [rateFallbacks, setRateFallbacks] = useState<Record<string, string>>({});
  const [apiHoldingProductIds, setApiHoldingProductIds] = useState<Set<string>>(() => new Set());
  const [holdingFallbacks, setHoldingFallbacks] = useState<Record<string, string>>({});
  const [holdingSyncStates, setHoldingSyncStates] = useState<ApiResult["holdingSyncStates"]>({});
  const [showApiSettings, setShowApiSettings] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasSyncFailure, setHasSyncFailure] = useState(false);
  const [syncFailures, setSyncFailures] = useState<string[]>([]);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [manualRefreshAvailableAt, setManualRefreshAvailableAt] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const productOverridesRef = useRef<ProductOverrideMap>({});
  const manualProductsRef = useRef<Product[]>([]);
  const hiddenSeedProductIdsRef = useRef<string[]>([]);
  const previewQuery = localPreview ? "?preview=1" : "";
  const holdingsEndpoint = `/private/api/holdings${previewQuery}`;
  const productsEndpoint = `/private/api/products${previewQuery}`;

  function openPrivateDashboard() {
    window.location.assign("/private/home");
  }

  useEffect(() => { productOverridesRef.current = productOverrides; }, [productOverrides]);
  useEffect(() => { manualProductsRef.current = manualProducts; }, [manualProducts]);
  useEffect(() => { hiddenSeedProductIdsRef.current = hiddenSeedProductIds; }, [hiddenSeedProductIds]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    async function loadHoldings() {
      try {
        const response = await fetch(holdingsEndpoint, { cache: "no-store" });
        if (!response.ok) throw new Error("cloud holdings unavailable");
        const data = await response.json() as HoldingsApiResult;
        if (data.products?.length) setProducts(data.products);
        setProductOverrides(data.overrides ?? {});
        setManualProducts(data.manualProducts ?? []);
        const hiddenIds = data.hiddenProductIds ?? data.hiddenSeedProductIds ?? [];
        setHiddenSeedProductIds(hiddenIds);
        productOverridesRef.current = data.overrides ?? {};
        manualProductsRef.current = data.manualProducts ?? [];
        hiddenSeedProductIdsRef.current = hiddenIds;
        if (data.found) {
          const next = { ...emptyHoldings, ...data.holdings };
          setHoldings(next);
          return next;
        }

        setHoldings(emptyHoldings);
        return emptyHoldings;
      } catch {
        setHoldings(emptyHoldings);
        return emptyHoldings;
      }
    }

    async function initialize() {
      if (isDemo) {
        setHoldings(publicDemoHoldings);
        setProductOverrides(publicDemoOverrides);
        setHoldingsReady(true);
        return;
      }
      void fetch("/private/api/session", { cache: "no-store" })
        .then((response) => response.ok ? response.json() as Promise<{ email: string }> : Promise.reject())
        .then((session) => setUserEmail(session.email))
        .catch(() => setUserEmail(null));
      const loaded = await loadHoldings();
      setHoldingsReady(true);
      await refreshRates(loaded);
    }

    const frame = window.requestAnimationFrame(() => void initialize());
    return () => {
      window.cancelAnimationFrame(frame);
    };
    // Initial load intentionally runs once for each fixed dashboard mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshRates(baseHoldings: HoldingMap = holdings, options?: { manual?: boolean }) {
    setLoading(true);
    try {
      const endpoint = options?.manual ? `${productsEndpoint}${productsEndpoint.includes("?") ? "&" : "?"}refresh=1` : productsEndpoint;
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error("rate refresh failed");
      const data = await response.json() as ApiResult;
      const hardFailure = data.cache?.state === "stale" || data.cache?.state === "error";
      const failures = data.failures?.filter(Boolean) ?? [];
      setHasSyncFailure(hardFailure || data.partial || failures.length > 0);
      setSyncFailures(failures);
      setRateFallbacks(data.rateFallbacks ?? {});
      setApiHoldingProductIds(new Set(data.holdingSourceIds ?? Object.keys(data.holdingUpdates ?? {})));
      setHoldingFallbacks(data.holdingFallbacks ?? {});
      setHoldingSyncStates(data.holdingSyncStates ?? {});
      // The API response is authoritative. An empty list means this account
      // has no discovered products yet; do not repopulate the old global seed
      // directory on the client.
      const nextProducts: Product[] = data.products ?? [];
      setProducts(nextProducts);
      const acceptedHoldingUpdates = Object.fromEntries(Object.entries(data.holdingUpdates ?? {}).filter(([productId]) => (
        nextProducts.find((product) => product.id === productId)?.holdingDataMode === "api"
      )));
      if (!isDemo && Object.keys(acceptedHoldingUpdates).length > 0) {
        const next = { ...baseHoldings, ...acceptedHoldingUpdates };
        setHoldings(next);
        try {
          await persistPortfolio(next, productOverridesRef.current, Object.keys(acceptedHoldingUpdates), manualProductsRef.current, [], hiddenSeedProductIdsRef.current);
        } catch {
          // The freshly read values stay visible even if the background cloud save fails.
        }
      }
      const updatedAt = data.cache?.updatedAt
        ?? data.fetchedAt
        ?? data.rates.reduce<string | null>((latest, rate) => !latest || rate.fetchedAt > latest ? rate.fetchedAt : latest, null);
      setLastUpdated(updatedAt);
      setManualRefreshAvailableAt(data.cache?.cooldownUntil ?? null);
      setClock(Date.now());
    } catch {
      setHasSyncFailure(true);
      setSyncFailures(["交易所"]);
    } finally {
      setLoading(false);
    }
  }

  async function persistPortfolio(next: HoldingMap, overrides: ProductOverrideMap, changedProductIds: string[], nextManualProducts: Product[], deletedIds: string[], hiddenSeedIds: string[]) {
    const response = await fetch(holdingsEndpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        holdings: next,
        overrides,
        changedProductIds,
        manualProducts: nextManualProducts.map(manualProductPayload),
        deletedManualProductIds: deletedIds,
        hiddenSeedProductIds: hiddenSeedIds,
      }),
    });
    if (!response.ok) throw new Error("cloud save failed");
    return response.json() as Promise<{ updatedAt: string }>;
  }

  async function savePortfolio(nextHoldings: HoldingMap, nextOverrides: ProductOverrideMap, changedProductIds: string[], nextManualProducts: Product[], deletedIds: string[], hiddenSeedIds: string[]) {
    const previousHoldings = holdings;
    const previousOverrides = productOverrides;
    const previousManualProducts = manualProducts;
    const previousHiddenSeedProductIds = hiddenSeedProductIds;
    setHoldings(nextHoldings);
    setProductOverrides(nextOverrides);
    setManualProducts(nextManualProducts);
    setHiddenSeedProductIds(hiddenSeedIds);
    hiddenSeedProductIdsRef.current = hiddenSeedIds;
    try {
      const result = await persistPortfolio(nextHoldings, nextOverrides, changedProductIds, nextManualProducts, deletedIds, hiddenSeedIds);
      setProductOverrides((current) => ({
        ...current,
        ...Object.fromEntries(changedProductIds.map((productId) => [productId, {
          apr: current[productId]?.apr ?? null,
          firstTierLimit: current[productId]?.firstTierLimit ?? null,
          termDays: current[productId]?.termDays ?? null,
          purchaseDate: current[productId]?.purchaseDate ?? null,
          eligibilityConfirmed: current[productId]?.eligibilityConfirmed ?? null,
          updatedAt: result.updatedAt,
        }])),
      }));
      return true;
    } catch {
      setHoldings(previousHoldings);
      setProductOverrides(previousOverrides);
      setManualProducts(previousManualProducts);
      setHiddenSeedProductIds(previousHiddenSeedProductIds);
      hiddenSeedProductIdsRef.current = previousHiddenSeedProductIds;
      return false;
    }
  }

  function beginEditing() {
    setDraftHoldings({ ...holdings });
    setDraftOverrides(structuredClone(productOverrides));
    setDraftManualProducts(structuredClone(manualProducts));
    setDraftHiddenSeedProductIds([...hiddenSeedProductIds]);
    setDeletedManualProductIds([]);
    setHoldingSaveError(false);
    setEditing(true);
  }

  function cancelEditing() {
    if (savingHoldings) return;
    setDraftHoldings({ ...holdings });
    setDraftOverrides(structuredClone(productOverrides));
    setDraftManualProducts(structuredClone(manualProducts));
    setDraftHiddenSeedProductIds([...hiddenSeedProductIds]);
    setDeletedManualProductIds([]);
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
        eligibilityConfirmed: current[productId]?.eligibilityConfirmed ?? productOverrides[productId]?.eligibilityConfirmed ?? null,
        updatedAt: current[productId]?.updatedAt ?? productOverrides[productId]?.updatedAt ?? null,
        ...patch,
      },
    }));
  }

  function addManualProduct() {
    const id = `manual-${crypto.randomUUID()}`;
    const account = accounts.find((candidate) => candidate.id === "binance-bahrain") ?? accounts[0];
    const product: Product = {
      id,
      accountId: account.id,
      exchange: account.exchange,
      region: account.region,
      asset,
      name: "手动活期理财",
      productDataMode: "manual",
      holdingDataMode: "manual",
      productType: "flexible",
      manualKind: "flexible",
      tiers: [{ id: `${id}-tier-0`, min: 0, max: null, apr: 0 }],
      source: { kind: "manual", label: "手动添加" },
      rateCoverage: "unavailable",
      identityKey: id,
    };
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
      return {
        ...next,
        accountId: account.id,
        exchange: account.exchange,
        region: account.region,
        productType: kind === "fixed" ? "fixed" : "flexible",
        name: kind === "fixed" ? "手动定期理财" : kind === "limited" ? "手动限时活期" : "手动活期理财",
        termDays: kind === "flexible" ? undefined : next.termDays,
      };
    }));
  }

  function deleteDraftProduct(productId: string) {
    const userProduct = draftManualProducts.some((product) => product.id === productId);
    if (userProduct) setDraftManualProducts((current) => current.filter((product) => product.id !== productId));
    else {
      const seedProduct = products.find((product) => product.id === productId);
      if (!seedProduct || !productCanBeRemoved(seedProduct)) return;
      setDraftHiddenSeedProductIds((current) => [...new Set([...current, productId])]);
    }
    setDraftHoldings((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== productId)) as HoldingMap);
    setDraftOverrides((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== productId)) as ProductOverrideMap);
    if (manualProducts.some((product) => product.id === productId)) {
      setDeletedManualProductIds((current) => [...new Set([...current, productId])]);
    }
  }

  async function finishEditing() {
    const hiddenSeedProductIdSet = new Set(draftHiddenSeedProductIds);
    const workingProducts = [...products.filter((product) => !hiddenSeedProductIdSet.has(product.id)), ...draftManualProducts];
    const changedProductIds = workingProducts.flatMap((product) => (
      (draftHoldings[product.id] ?? 0) !== (holdings[product.id] ?? 0)
      || !sameOverride(draftOverrides[product.id], productOverrides[product.id])
      || (product.id.startsWith("manual-") && !sameManualProduct(product, manualProducts.find((item) => item.id === product.id)))
        ? [product.id]
        : []
    ));
    const hiddenProductsChanged = !sameIdSet(draftHiddenSeedProductIds, hiddenSeedProductIds);
    if (changedProductIds.length === 0 && deletedManualProductIds.length === 0 && !hiddenProductsChanged) {
      setEditing(false);
      return;
    }
    if (isDemo) {
      setHoldings(draftHoldings);
      setProductOverrides(draftOverrides);
      setManualProducts(draftManualProducts);
      setHiddenSeedProductIds(draftHiddenSeedProductIds);
      hiddenSeedProductIdsRef.current = draftHiddenSeedProductIds;
      setDeletedManualProductIds([]);
      setEditing(false);
      return;
    }
    setSavingHoldings(true);
    setHoldingSaveError(false);
    const saved = await savePortfolio(draftHoldings, draftOverrides, changedProductIds, draftManualProducts, deletedManualProductIds, draftHiddenSeedProductIds);
    setSavingHoldings(false);
    if (saved) setEditing(false);
    else setHoldingSaveError(true);
  }

  const activeHoldings = editing ? draftHoldings : holdings;
  const activeOverrides = editing ? draftOverrides : productOverrides;
  const activeHiddenSeedProductIds = editing ? draftHiddenSeedProductIds : hiddenSeedProductIds;
  const activeBaseProducts = useMemo(() => {
    const hiddenIds = new Set(activeHiddenSeedProductIds);
    return [...products.filter((product) => !hiddenIds.has(product.id)), ...(editing ? draftManualProducts : manualProducts)];
  }, [activeHiddenSeedProductIds, draftManualProducts, editing, manualProducts, products]);
  const resolvedProducts = useMemo(() => activeBaseProducts.map((product) => applyProductOverride(product, activeOverrides[product.id])), [activeBaseProducts, activeOverrides]);
  const holdingIsKnown = (product: Product) => isDemo || product.holdingDataMode === "manual" || apiHoldingProductIds.has(product.id);
  const assetProducts = useMemo(() => resolvedProducts
    .filter((product) => product.asset === asset && (editing || !product.requiresLiveRate || product.source.kind === "live" || (activeHoldings[product.id] ?? 0) > 0 || activeOverrides[product.id]?.apr != null))
    .sort((left, right) => {
      const leftIsNew = editing && left.id.startsWith("manual-") && !manualProducts.some((product) => product.id === left.id);
      const rightIsNew = editing && right.id.startsWith("manual-") && !manualProducts.some((product) => product.id === right.id);
      if (leftIsNew !== rightIsNew) return leftIsNew ? -1 : 1;
      return left.exchange.localeCompare(right.exchange, "en", { sensitivity: "base" })
      || left.region.localeCompare(right.region, "en", { sensitivity: "base" })
      || left.name.localeCompare(right.name, "en", { sensitivity: "base" });
    }), [activeHoldings, activeOverrides, asset, editing, manualProducts, resolvedProducts]);
  const visibleProducts = assetProducts.filter((product) => isDemo
    || isPrivatePortfolioProduct(product, activeHoldings[product.id] ?? 0));
  const tableProducts = editing ? assetProducts : visibleProducts;
  const opportunityProducts = visibleProducts.filter((product) => product.rateCoverage !== "unavailable" && (!product.eligibilityRequired || (activeHoldings[product.id] ?? 0) > 0));
  const totalHolding = visibleProducts.reduce((sum, product) => holdingIsKnown(product) ? sum + (activeHoldings[product.id] ?? 0) : sum, 0);
  const calculableProducts = visibleProducts.filter((product) => holdingIsKnown(product) && productParticipatesInInterest(product, activeHoldings[product.id] ?? 0, activeOverrides[product.id]));
  const calculableOpportunityProducts = opportunityProducts.filter((product) => productParticipatesInInterest(product, activeHoldings[product.id] ?? 0, activeOverrides[product.id]));
  const comparableOpportunityProducts = opportunityProducts.filter((product) => product.rateCoverage === "max_only" || productParticipatesInInterest(product, activeHoldings[product.id] ?? 0, activeOverrides[product.id]));
  const calculableHolding = calculableProducts.reduce((sum, product) => sum + (activeHoldings[product.id] ?? 0), 0);
  const annualEarn = calculableProducts.reduce((sum, product) => sum + (activeHoldings[product.id] ?? 0) * effectiveApr(product, activeHoldings[product.id] ?? 0) / 100, 0);
  const portfolioApr = calculableHolding ? annualEarn / calculableHolding * 100 : 0;
  const bestProduct = comparableOpportunityProducts.reduce<Product | null>((best, product) => !best || (product.tiers[0]?.apr ?? 0) > (best.tiers[0]?.apr ?? 0) ? product : best, null);
  const highYieldLeft = calculableOpportunityProducts.reduce((sum, product) => isDemo || holdingIsKnown(product) ? sum + remainingHighYield(product, activeHoldings[product.id] ?? 0) : sum, 0);
  const tierOneOverflow = calculableProducts.reduce((sum, product) => sum + overflowFromFirstTier(product, activeHoldings[product.id] ?? 0), 0);
  const holdingProductCount = visibleProducts.filter((product) => holdingIsKnown(product) && (activeHoldings[product.id] ?? 0) > 0).length;
  const manualRefreshCooling = Boolean(manualRefreshAvailableAt && Date.parse(manualRefreshAvailableAt) > clock);
  const automaticRefreshSummary = formatSyncDateTime(nextScheduledRefreshAt(clock));
  const currentDataSummary = loading
    ? "正在更新…"
    : localPreview
      ? lastUpdated
        ? `本地测试数据截至 ${formatSyncDateTime(lastUpdated)}；不会写入数据库。`
        : "正在加载本地测试数据…"
    : isDemo
      ? "以下均为演示数据。"
      : lastUpdated
        ? `当前数据截至 ${formatSyncDateTime(lastUpdated)}${automaticRefreshSummary ? `，预计 ${automaticRefreshSummary} 自动更新` : ""}。`
        : "暂无成功数据。";
  const wholeUpdateFailed = syncFailures.some(isWholeUpdateFailure);
  const failedPlatforms = [...new Set(syncFailures.map(failureTarget).filter(Boolean))];
  const failureSummary = wholeUpdateFailed
    ? "本次产品和持仓数据更新失败；下次更新将重试。"
    : `${failedPlatforms.length ? failedPlatforms.join("、") : "交易所"} API 暂不可用；下次更新将重试。`;

  return (
    <main className="min-h-screen">
      <nav className="top-nav sticky top-0 z-20 px-5 backdrop-blur lg:px-10" aria-label="主导航">
        <div className="mx-auto flex min-h-14 max-w-[1500px] flex-wrap items-center gap-x-4 sm:flex-nowrap">
          <div className="flex items-center py-2"><p className="type-title font-semibold tracking-[-0.025em]">Stable Earn</p></div>
          <div className="order-3 h-11 w-full self-stretch sm:order-none sm:ml-8 sm:h-auto sm:w-auto"><AssetSwitch asset={asset} onChange={(nextAsset) => { if (nextAsset === asset) return; if (editing) setShowAssetSwitchWarning(true); else setAsset(nextAsset); }} /></div>
          <HeaderMenu
            userEmail={userEmail}
            demo={isDemo}
            loading={loading}
            manualRefreshCooling={manualRefreshCooling}
            cooldownUntil={manualRefreshAvailableAt}
            onManualRefresh={() => void refreshRates(activeHoldings, { manual: true })}
          />
        </div>
      </nav>

      <div className="mx-auto max-w-[1500px] px-5 py-5 lg:px-10 lg:py-6">
        <div className="card type-caption mb-5 flex items-center justify-between gap-4 px-5 py-3.5" aria-live="polite">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <svg className="sync-notice-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
            <p className="text-muted font-normal"><span className="text-secondary">{currentDataSummary}</span>{!loading && !isDemo && hasSyncFailure && <span className="text-warning font-semibold"> {failureSummary}</span>}</p>
          </div>
          {isDemo && <ActionButton size="small" className="shrink-0" onClick={openPrivateDashboard}>登录查看我的数据</ActionButton>}
        </div>
        <section className="metrics-panel card mb-7 grid overflow-hidden sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
          <Metric highlight label={`总持仓 · ${asset}`} value={holdingsReady ? formatAmount(totalHolding) : "—"} note={holdingsReady ? `${holdingProductCount} 个持仓产品` : "正在同步持仓…"} />
          <Metric label="组合有效 APR" value={holdingsReady ? `${portfolioApr.toFixed(2)}%` : "—"} note={holdingsReady ? "按各阶梯实际占用加权" : "正在同步持仓…"} />
          <Metric label={`预计每日收益 · ${asset}`} value={holdingsReady ? formatAmount(annualEarn / 365) : "—"} note={holdingsReady ? "含活期、定期" : "正在同步持仓…"} />
          <Metric label={bestProduct?.rateCoverage === "max_only" ? "最高公开 APR" : "最佳首档 APR"} value={holdingsReady ? (bestProduct ? `${(bestProduct.tiers[0]?.apr ?? 0).toFixed(2)}%` : "—") : "—"} note={holdingsReady ? (bestProduct ? `${accountName(bestProduct.accountId)}${bestProduct.rateCoverage === "max_only" ? " · 阶梯待确认" : ""}` : "暂无产品") : "正在同步持仓…"} />
          <Metric label="可用高息额度" value={holdingsReady ? formatAmount(highYieldLeft) : "—"} note={holdingsReady ? "首档与定期额度" : "正在同步持仓…"} />
          <Metric label="超出首档" value={holdingsReady ? formatAmount(tierOneOverflow) : "—"} valueTone={holdingsReady && tierOneOverflow > 0 ? "danger" : "default"} note={holdingsReady ? (tierOneOverflow > 0 ? "已进入次档" : "未超出首档") : "正在同步持仓…"} />
        </section>

        <section className="card overflow-hidden">
          <div className="table-toolbar">
            <div><h2 className="type-title font-semibold tracking-[-0.02em]">{asset} 持仓</h2><div className="mt-1"><p className="text-muted type-caption">{editing ? <>展示手动添加和 API 同步的产品{!isDemo && <>，<ActionButton variant="text" size="small" className="inline-action px-1 py-0.5" onClick={() => setShowApiSettings(true)}>配置 API</ActionButton></>}</> : "仅展示已有持仓，或 APR > 4% 的活期及 7 天内定期产品"}</p></div></div>
            {editing ? <div className="flex items-center gap-2"><ActionButton variant="secondary" onClick={cancelEditing} disabled={savingHoldings}>取消</ActionButton><ActionButton variant="secondary" onClick={addManualProduct} disabled={savingHoldings}>添加产品</ActionButton><ActionButton onClick={() => void finishEditing()} disabled={savingHoldings}>{savingHoldings ? "保存中…" : "保存持仓"}</ActionButton></div> : <div className="flex items-center gap-2"><ActionButton variant={isDemo ? "secondary" : "primary"} onClick={beginEditing} disabled={!holdingsReady}>编辑持仓</ActionButton></div>}
          </div>
          {holdingSaveError && <div className="error-panel type-caption mx-5 mt-4 px-3 py-2 font-medium">保存失败，请检查网络后重试；表格中的修改仍然保留。</div>}
          <div className="overflow-x-auto"><table className="product-table type-body" aria-busy={!holdingsReady}><colgroup><col className="product-table-col-platform" /><col className="product-table-col-rate" /><col className="product-table-col-holding" /><col className="product-table-col-effective" /></colgroup><thead><tr><th>平台 / 产品</th><th>产品与 APR</th><th>持仓 / 额度使用</th><th>有效 APR</th></tr></thead><tbody>{holdingsReady ? tableProducts.length > 0 ? tableProducts.map((listedProduct) => {
            const baseProduct = activeBaseProducts.find((product) => product.id === listedProduct.id) ?? listedProduct;
            const manualSettings = activeOverrides[listedProduct.id];
            const displayProduct = applyProductOverride(baseProduct, manualSettings);
            const isManualProduct = listedProduct.id.startsWith("manual-");
            return <ProductRow key={listedProduct.id} product={displayProduct} baseProduct={baseProduct} manualSettings={manualSettings} holding={activeHoldings[listedProduct.id] ?? 0} holdingAvailable={holdingIsKnown(baseProduct)} holdingSyncState={holdingSyncStates?.[listedProduct.id]} editing={editing} editable={isDemo || baseProduct.holdingDataMode === "manual"} saving={savingHoldings} manualProduct={isManualProduct} removable={isManualProduct || productCanBeRemoved(baseProduct)} rateFallbackAt={baseProduct.productDataMode === "api" ? rateFallbacks[listedProduct.id] : undefined} holdingFallbackAt={!isDemo && baseProduct.holdingDataMode === "api" ? holdingFallbacks[listedProduct.id] : undefined} onHoldingChange={(value) => setDraftHoldings((current) => ({ ...current, [listedProduct.id]: value }))} onOverrideChange={(patch) => updateDraftOverride(listedProduct.id, patch)} onManualProductChange={(patch) => updateDraftManualProduct(listedProduct.id, patch)} onDelete={() => deleteDraftProduct(listedProduct.id)} />;
          }) : <tr><td colSpan={4}><EmptyProductState /></td></tr> : <tr><td colSpan={4} className="text-muted type-body px-5 py-12 text-center">正在同步持仓…</td></tr>}</tbody></table></div>
        </section>

        <footer className="site-footer text-muted type-caption py-6"><p>数据仅用于监控与比较，不构成投资建议。实际到账以平台账户为准。</p><a className="github-footer-link" href="https://github.com/noood/stable-earn" target="_blank" rel="noreferrer" aria-label="GitHub 源码仓库" title="GitHub 源码仓库"><Image src="/GitHub_Lockup_Black_Clearspace.svg" width={448} height={127} alt="" aria-hidden="true" /></a></footer>
      </div>

      {!isDemo && showApiSettings && <ApiSettings onClose={() => setShowApiSettings(false)} onCooldownChange={() => setManualRefreshAvailableAt(null)} />}
      {showAssetSwitchWarning && <ModalFrame ariaLabel="请先完成编辑" title="请先完成编辑" onClose={() => setShowAssetSwitchWarning(false)}><p className="text-secondary type-body">请先保存或取消当前修改，再切换币种。</p><div className="mt-5 flex justify-end"><ActionButton onClick={() => setShowAssetSwitchWarning(false)}>知道了</ActionButton></div></ModalFrame>}
    </main>
  );
}

function AssetSwitch({ asset, onChange }: { asset: Asset; onChange: (asset: Asset) => void }) {
  const assets: Asset[] = ["USDT", "USDC", "USDGO", "BTC"];
  return <div className="asset-switch inline-flex h-full w-fit max-w-full flex-nowrap items-stretch gap-1 overflow-x-auto">{assets.map((item) => <button key={item} onClick={() => onChange(item)} aria-current={asset === item ? "page" : undefined} className={`type-label -mb-px flex shrink-0 items-center gap-2 border-b-[3px] px-3.5 font-semibold transition-colors ${asset === item ? "border-[var(--brand)] text-[var(--brand)]" : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]"}`}><AssetIcon asset={item} /><span>{item}</span></button>)}</div>;
}

function AssetIcon({ asset }: { asset: Asset }) {
  if (asset === "USDT") return <svg className="asset-icon" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#009393" /><path fill="#fff" d="M8 7h16v4h-6v2.2c5 .3 8.4 1.3 8.4 2.7s-3.4 2.5-8.4 2.8V25h-4v-6.3c-5-.3-8.4-1.4-8.4-2.8s3.4-2.4 8.4-2.7V11H8V7Zm8 9.1c3.4 0 6-.3 7.1-.7-1.1-.4-3.7-.7-7.1-.7s-6 .3-7.1.7c1.1.4 3.7.7 7.1.7Z" /></svg>;
  if (asset === "USDC") return <svg className="asset-icon" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#2775CA" /><path fill="#fff" d="M17.2 7.2v2c2 .3 3.4 1.5 3.8 3.3l-2.6.6c-.3-1.1-1.1-1.7-2.4-1.7-1.4 0-2.2.6-2.2 1.5 0 .8.6 1.2 2.7 1.7 3.2.7 4.7 1.9 4.7 4.3 0 2.2-1.5 3.7-4 4.1v2h-2.3v-2c-2.4-.4-3.9-1.8-4.2-4l2.7-.5c.2 1.4 1.2 2.2 2.7 2.2 1.5 0 2.4-.6 2.4-1.6 0-.9-.7-1.3-2.8-1.8-3.1-.7-4.6-1.9-4.6-4.2 0-2 1.4-3.5 3.8-3.9v-2h2.3Z" /><path d="M9.1 8.7a10 10 0 0 0 0 14.6M22.9 8.7a10 10 0 0 1 0 14.6" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" /></svg>;
  if (asset === "USDGO") {
    // This icon intentionally stays on the source CDN so it matches the current USDGO artwork.
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="asset-icon asset-icon-image" src="https://pbs.twimg.com/profile_images/2019714133122580480/IE6UKNPl_400x400.jpg" alt="" aria-hidden="true" referrerPolicy="no-referrer" />;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="asset-icon asset-icon-image" src="https://upload.wikimedia.org/wikipedia/commons/thumb/4/46/Bitcoin.svg/1920px-Bitcoin.svg.png" alt="" aria-hidden="true" referrerPolicy="no-referrer" />;
}

function useDismissiblePopover<TTrigger extends HTMLElement, TPopover extends HTMLElement>(open: boolean, setOpen: Dispatch<SetStateAction<boolean>>, triggerRef: RefObject<TTrigger | null>, popoverRef: RefObject<TPopover | null>) {
  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && !triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    }
    function closeFromEscape(event: KeyboardEvent) { if (event.key === "Escape") setOpen(false); }
    function closeFromScroll() { setOpen(false); }
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    window.addEventListener("scroll", closeFromScroll, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
      window.removeEventListener("scroll", closeFromScroll, true);
    };
  }, [open, popoverRef, setOpen, triggerRef]);
}

function HeaderMenu({ userEmail, demo, loading, manualRefreshCooling, cooldownUntil, onManualRefresh }: { userEmail: string | null; demo: boolean; loading: boolean; manualRefreshCooling: boolean; cooldownUntil: string | null; onManualRefresh: () => void }) {
  const menuRef = useDismissibleDetails();
  const cooldownTime = cooldownUntil ? new Date(cooldownUntil).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : null;
  const refreshLabel = loading
    ? "正在刷新…"
    : <><span>手动刷新</span>{manualRefreshCooling && cooldownTime && <span className="menu-item-refresh-note">冷却至 {cooldownTime}</span>}</>;

  function closeMenu(event: React.MouseEvent<HTMLButtonElement>, action: () => void) {
    event.currentTarget.closest("details")?.removeAttribute("open");
    action();
  }

  return <div className="ml-auto flex items-center justify-end py-2"><details ref={menuRef} className="action-menu relative"><summary className="icon-button action-menu-trigger list-none" aria-label="更多操作"><span aria-hidden="true">⋯</span></summary><div className="surface-popover action-menu-popover">{userEmail && <div className="menu-account"><p className="menu-account-label">当前账号</p><p className="menu-account-value" title={userEmail}>{userEmail}</p></div>}{!demo && <button type="button" disabled={loading || manualRefreshCooling} onClick={(event) => closeMenu(event, onManualRefresh)} className="menu-item menu-item-leading menu-item-refresh">{refreshLabel}</button>}{!demo && <a href="/logout" className="menu-item menu-item-danger">退出登录</a>}</div></details></div>;
}

function ProductRow({ product, baseProduct, manualSettings, holding, holdingAvailable, holdingSyncState, editing, editable, saving, manualProduct, removable, rateFallbackAt, holdingFallbackAt, onHoldingChange, onOverrideChange, onManualProductChange, onDelete }: { product: Product; baseProduct: Product; manualSettings?: ProductOverride; holding: number; holdingAvailable: boolean; holdingSyncState?: HoldingSyncState; editing: boolean; editable: boolean; saving: boolean; manualProduct: boolean; removable: boolean; rateFallbackAt?: string; holdingFallbackAt?: string; onHoldingChange: (value: number) => void; onOverrideChange: (patch: Partial<ProductOverride>) => void; onManualProductChange: (patch: ManualProductPatch) => void; onDelete: () => void }) {
  const account = accounts.find((item) => item.id === product.accountId)!;
  const productInfoIssues = productInformationIssues(product, holdingAvailable ? holding : 0, manualSettings);
  return (
    <tr className={`product-row ${!editing && holdingAvailable && holding <= 0 ? "product-row-empty" : ""}`}>
      <TableCell>
        {editing && manualProduct
          ? <ManualProductIdentityEditor product={baseProduct} account={account} disabled={saving} onChange={onManualProductChange} onDelete={onDelete} />
          : <div className="flex items-start gap-3"><AccountBadge account={account} /><div className="min-w-0"><div className="type-body font-semibold">{account.name}</div><div className="text-muted type-caption mt-0.5 max-w-[220px] whitespace-normal break-words">{standardProductName(product)}</div>{editing && removable && <button type="button" className="manual-product-delete text-danger type-caption" disabled={saving} onClick={onDelete}>删除产品</button>}</div></div>}
      </TableCell>
      <TableCell><ProductTierSummary product={product} baseProduct={baseProduct} manualSettings={manualSettings} holding={holding} editing={editing} saving={saving} manualProduct={manualProduct} rateFallbackAt={rateFallbackAt} onOverrideChange={onOverrideChange} onManualProductChange={onManualProductChange} /></TableCell>
      <TableCell><ProductHolding product={product} account={account} holding={holding} holdingAvailable={holdingAvailable} holdingSyncState={holdingSyncState} editing={editing} editable={editable} saving={saving} holdingFallbackAt={holdingFallbackAt} productInfoIssues={productInfoIssues} onHoldingChange={onHoldingChange} /></TableCell>
      <TableCell className="type-body font-semibold tabular-nums">{holdingAvailable && productInfoIssues.length === 0 && holding > 0
        ? `${effectiveApr(product, holding).toFixed(2)}%`
        : <span className="text-subtle font-normal">—</span>}</TableCell>
    </tr>
  );
}

function ManualProductIdentityEditor({ product, account, disabled, onChange, onDelete }: { product: Product; account: Account; disabled: boolean; onChange: (patch: ManualProductPatch) => void; onDelete: () => void }) {
  return <div className="flex items-start gap-3"><AccountBadge account={account} /><div className="manual-identity-fields min-w-0 flex-1"><InlineSelect className="inline-select-trigger-primary" ariaLabel="平台" value={product.accountId} options={accounts.map((item) => ({ value: item.id, label: item.name }))} disabled={disabled} onChange={(accountId) => onChange({ accountId })} /><InlineSelect className="inline-select-trigger-secondary" ariaLabel="产品类型" value={product.manualKind ?? "flexible"} options={[{ value: "flexible", label: "活期理财" }, { value: "fixed", label: "定期理财" }, { value: "limited", label: "限时活期" }]} disabled={disabled} onChange={(manualKind) => onChange({ manualKind: manualKind as Product["manualKind"] })} /><button type="button" className="manual-product-delete text-danger type-caption" disabled={disabled} onClick={onDelete}>删除产品</button></div></div>;
}

function InlineSelect({ ariaLabel, value, options, disabled, className = "", onChange }: { ariaLabel: string; value: string; options: Array<{ value: string; label: string }>; disabled: boolean; className?: string; onChange: (value: string) => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, maxHeight: 240 });
  const selectedLabel = options.find((option) => option.value === value)?.label ?? value;
  useDismissiblePopover(open, setOpen, buttonRef, menuRef);

  function toggleMenu() {
    if (disabled) return;
    if (!open) {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) setPosition({ top: rect.bottom + 6, left: rect.left, maxHeight: Math.max(120, window.innerHeight - rect.bottom - 20) });
    }
    setOpen((current) => !current);
  }

  return <><button ref={buttonRef} type="button" className={`inline-select-trigger ${className}`} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={toggleMenu}><span>{selectedLabel}</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button>{open && createPortal(<div ref={menuRef} className="inline-select-menu" role="listbox" aria-label={ariaLabel} style={{ top: position.top, left: position.left, maxHeight: position.maxHeight }}>{options.map((option) => <button key={option.value} type="button" role="option" aria-selected={option.value === value} onClick={() => { onChange(option.value); setOpen(false); }}><span>{option.label}</span>{option.value === value && <span aria-hidden="true">✓</span>}</button>)}</div>, document.body)}</>;
}

function EmptyProductState() {
  return <div className="empty-product-state"><p className="text-muted type-label font-semibold">吸引人的稳定理财尚未出现！</p></div>;
}

function isPrivatePortfolioProduct(product: Product, holding: number) {
  return product.id.startsWith("manual-")
    || holding > 0
    || isHighYieldShortTermOpportunity(product);
}

function isHighYieldShortTermOpportunity(product: Product) {
  if (product.rateCoverage === "unavailable" || highestProductApr(product) <= minimumVisibleApr) return false;
  const termDays = productTermDays(product);
  return product.productType !== "fixed" || (termDays !== null && termDays <= 7);
}

function ProductTierSummary({ product, baseProduct, manualSettings, holding, editing, saving, manualProduct, rateFallbackAt, onOverrideChange, onManualProductChange }: { product: Product; baseProduct: Product; manualSettings?: ProductOverride; holding: number; editing: boolean; saving: boolean; manualProduct: boolean; rateFallbackAt?: string; onOverrideChange: (patch: Partial<ProductOverride>) => void; onManualProductChange: (patch: ManualProductPatch) => void }) {
  const manualApr = productNeedsManualApr(baseProduct);
  const manualLimit = productNeedsManualLimit(baseProduct);
  const manualTerm = productNeedsManualTerm(baseProduct);
  const fixedFacts = product.productType === "fixed" || product.manualKind === "limited" ? fixedProductFacts(product) : [];
  const durationDays = productTermDays(product);
  const termStatus = productTermStatus(product, manualSettings?.purchaseDate);
  const productInfoIssues = productInformationIssues(product, holding, manualSettings);
  const apiManaged = baseProduct.productDataMode === "api";
  const rateHeadline = rateHeadlineFor(product, apiManaged);
  const sourceText = rateFallbackAt && product.rateCoverage !== "unavailable"
    ? `产品信息沿用 ${formatSyncDateTime(rateFallbackAt)} 的缓存数据`
    : productInfoIssues.length === 0 && apiManaged && editing ? "来自 API" : "";
  const termStatusText: ReactNode = termStatus
    ? termStatus.remainingDays > 0
      ? <>买入 {formatShortDate(manualSettings?.purchaseDate)} · 已进行 {termStatus.elapsedDays}/{termStatus.durationDays} 天 · 还有 <span className="font-semibold tabular-nums">{termStatus.remainingDays} 天到期</span></>
      : <>买入 {formatShortDate(manualSettings?.purchaseDate)} · 已到期 <span className="font-semibold tabular-nums">{Math.abs(termStatus.remainingDays)} 天</span></>
    : "";
  const incompleteText = productInfoIssues.length > 0 ? productInformationNote(productInfoIssues) : "";

  return <div className="space-y-1.5"><ProductRateHeadline {...rateHeadline} />
    {fixedFacts.map(([label, value]) => <ProductFact key={label} label={label} value={value} />)}
    {product.eligibilityRequired && product.eligibilityStatus !== "eligible" && product.eligibilityStatus !== "ineligible" && editing && <label className="eligibility-confirmation"><input type="checkbox" checked={manualSettings?.eligibilityConfirmed === true} disabled={saving} onChange={(event) => onOverrideChange({ eligibilityConfirmed: event.currentTarget.checked })} /><span>我确认账号符合该资格</span></label>}
    {!editing && manualTerm && <ProductFact label="活动期限" value={durationDays ? formatTerm(durationDays) : "待填写"} />}
    {sourceText && <ProductMeta text={sourceText} warning={Boolean(rateFallbackAt)} />}
    {incompleteText && <ProductMeta text={incompleteText} warning={holding > 0} />}
    {!editing && termStatusText && <ProductMeta text={termStatusText} warning={Boolean(termStatus && termStatus.remainingDays <= 0)} />}
    {editing && (manualApr || manualLimit || manualTerm || (manualProduct && baseProduct.manualKind !== "flexible") || (productNeedsPurchaseDate(product) && Boolean(durationDays))) && <div className="manual-fields">
      {manualLimit && <ManualLimitInput value={manualSettings?.firstTierLimit ?? null} asset={product.asset} disabled={saving} onChange={(firstTierLimitValue) => onOverrideChange({ firstTierLimit: firstTierLimitValue })} />}
      {manualApr && <ManualAprInput value={manualSettings?.apr ?? null} disabled={saving} onChange={(apr) => onOverrideChange({ apr })} />}
      {manualTerm && <ManualTermInput label="活动期限" value={manualSettings?.termDays ?? null} disabled={saving} onChange={(termDays) => onOverrideChange({ termDays })} />}
      {manualProduct && baseProduct.manualKind !== "flexible" && <ManualTermInput value={baseProduct.termDays ?? null} disabled={saving} onChange={(termDays) => onManualProductChange({ termDays: termDays ?? undefined })} />}
      {productNeedsPurchaseDate(product) && durationDays && <PurchaseDateInput value={manualSettings?.purchaseDate ?? null} durationDays={durationDays} disabled={saving} onChange={(purchaseDate) => onOverrideChange({ purchaseDate })} />}
    </div>}
  </div>;
}

function ProductMeta({ text, title, warning = false }: { text: ReactNode; title?: string; warning?: boolean }) {
  const resolvedTitle = title ?? (typeof text === "string" ? text : undefined);
  return <p className={`product-meta ${warning ? "product-meta-warning" : "text-muted"}`} title={resolvedTitle}>{text}</p>;
}

function ProductRateHeadline({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return <div className="product-rate-headline"><span>{label}</span><span className={`status-chip ${muted ? "status-chip-muted" : "status-chip-highlight"}`}>{value}</span></div>;
}

function rateHeadlineFor(product: Product, apiManaged: boolean) {
  const firstTier = product.tiers[0];
  const capacityName = product.productType === "fixed" ? "申购额度" : "首档";
  if (product.rateCoverage === "unavailable") {
    const knownManualLimit = !apiManaged && firstTier?.max !== null && firstTier?.max !== undefined;
    return {
      label: apiManaged ? "额度待获取" : knownManualLimit ? `${capacityName} · ${tierLabel(firstTier.min, firstTier.max)}` : `${capacityName}额度待填写`,
      value: apiManaged ? "APR 待获取" : "APR 待填写",
      muted: true,
    };
  }
  if (product.rateCoverage === "max_only") {
    return { label: "官网最高", value: `最高 ${firstTier?.apr.toFixed(2) ?? "0.00"}%` };
  }
  if (product.rateCoverage === "base_only") {
    return { label: apiManaged ? `${capacityName} · 上限待确认` : `${capacityName}额度待填写`, value: `${firstTier?.apr.toFixed(2) ?? "0.00"}%` };
  }
  return {
    label: `${capacityName} · ${firstTier ? tierLabel(firstTier.min, firstTier.max) : "待获取"}`,
    value: `${firstTier?.apr.toFixed(2) ?? "0.00"}%`,
  };
}

function ProductFact({ label, value }: { label: string; value: string }) {
  return <div className="product-fact"><span>{label}</span><span className="tabular-nums">{value}</span></div>;
}

function ProductHolding({ product, account, holding, holdingAvailable, holdingSyncState, editing, editable, saving, holdingFallbackAt, productInfoIssues, onHoldingChange }: { product: Product; account: Account; holding: number; holdingAvailable: boolean; holdingSyncState?: HoldingSyncState; editing: boolean; editable: boolean; saving: boolean; holdingFallbackAt?: string; productInfoIssues: string[]; onHoldingChange: (value: number) => void }) {
  const firstTier = product.tiers[0];
  const firstTierCapacity = firstTier.max === null ? null : firstTier.max - firstTier.min;
  const usedInFirstTier = firstTierCapacity === null ? holding : Math.max(0, Math.min(firstTierCapacity, holding - firstTier.min));
  const firstTierProgress = firstTierCapacity ? Math.min(100, usedInFirstTier / firstTierCapacity * 100) : 100;
  const overflow = overflowFromFirstTier(product, holding);
  const nextApr = product.tiers[1]?.apr;
  const capacityLabel = product.productType === "fixed" ? "申购额度" : "首档";
  const holdingAmountClassName = editing ? undefined : "holding-summary-amount";
  const holdingDetailClassName = editing ? undefined : "holding-summary-detail";
  const holdingLabel = (detail?: string) => <><span className={holdingAmountClassName}>持仓 {formatAmount(holding)}</span>{detail && <span className={holdingDetailClassName}> / {detail}</span>}</>;
  const holdingCacheNote = holdingFallbackAt ? `持仓沿用 ${formatSyncDateTime(holdingFallbackAt)} 的缓存数据` : undefined;

  let summary: ReactNode = null;
  if (!holdingAvailable) {
    summary = <HoldingSummary muted compact label={editing ? undefined : <span className={holdingAmountClassName}>持仓未获取</span>} note={holdingSyncNote(holdingSyncState)} />;
  } else if (productInfoIssues.length > 0) {
    // Product completeness is described in the APR column. Keep this column
    // focused on the holding amount and its cache state. In edit mode the
    // input already contains the amount, but a stale-cache note still matters.
    summary = editing
      ? holdingCacheNote ? <HoldingSummary muted compact cacheNote={holdingCacheNote} /> : null
      : <HoldingSummary muted compact label={holdingLabel()} cacheNote={holdingCacheNote} />;
  } else if (firstTierCapacity === null) {
    summary = <HoldingSummary compact label={holdingLabel(`${capacityLabel}不限额`)} cacheNote={holdingCacheNote} />;
  } else {
    const note = overflow > 0
      ? `超出${capacityLabel} +${formatAmount(overflow)} ${product.asset}${nextApr !== undefined ? ` · 按 ${nextApr.toFixed(2)}%` : " · 不再计入本产品"}`
      : `${product.productType === "fixed" ? "还可申购" : "还可放"} ${formatAmount(Math.max(0, firstTierCapacity - usedInFirstTier))} ${product.asset}`;
    summary = <HoldingSummary label={holdingLabel(`${capacityLabel} ${formatAmount(firstTierCapacity)}`)} cacheNote={holdingCacheNote} note={note} progress={firstTierProgress} progressLabel={`${account.name} ${capacityLabel}使用进度`} noteTone={overflow > 0 ? "warning" : "default"} muted={product.eligibilityRequired && holding <= 0} compact={editing} />;
  }

  return <div className="holding-column">{editing && (editable
    ? <HoldingInput value={holding} asset={product.asset} disabled={saving} onChange={onHoldingChange} />
    : <div className="holding-editor holding-editor-readonly"><span className="text-muted flex items-baseline gap-2"><span className="type-micro font-medium">{product.asset}</span><span className="type-body font-medium tabular-nums">{holdingAvailable ? formatAmount(holding) : "未获取"}</span></span>{holdingAvailable && !holdingFallbackAt && <span className="text-muted type-micro">来自 API</span>}</div>)}{summary}</div>;
}

function ManualLimitInput({ value, placeholder, asset, disabled, onChange }: { value: number | null; placeholder?: number; asset: Asset; disabled: boolean; onChange: (value: number | null) => void }) {
  return <ManualNumberInput label="首档额度" value={value} placeholder={placeholder} suffix={asset} disabled={disabled} maxDecimals={8} onChange={(nextValue) => onChange(nextValue !== null && nextValue > 0 ? nextValue : null)} />;
}

function ManualAprInput({ value, placeholder, note, disabled, onChange }: { value: number | null; placeholder?: number; note?: string; disabled: boolean; onChange: (value: number | null) => void }) {
  return <ManualNumberInput label="APR" value={value} placeholder={placeholder} suffix="%" note={note} disabled={disabled} maxDecimals={4} onChange={onChange} />;
}

function ManualTermInput({ label = "期限", value, disabled, onChange }: { label?: string; value: number | null; disabled: boolean; onChange: (value: number | null) => void }) {
  return <ManualNumberInput label={label} value={value} placeholder="填写" suffix="天" disabled={disabled} maxDecimals={2} onChange={(termDays) => onChange(termDays !== null && termDays > 0 ? termDays : null)} />;
}

function ManualNumberInput({ label, value, placeholder, suffix, note, disabled, maxDecimals, onChange }: { label: string; value: number | null; placeholder?: number | string; suffix: string; note?: string; disabled: boolean; maxDecimals: number; onChange: (value: number | null) => void }) {
  const [displayValue, setDisplayValue] = useState(value === null ? "" : String(value));

  function updateValue(nextValue: string) {
    const normalized = nextValue.replace(",", ".");
    if (!new RegExp(`^\\d*(?:\\.\\d{0,${maxDecimals}})?$`).test(normalized)) return;
    setDisplayValue(normalized);
    onChange(normalized === "" ? null : Math.max(0, Number(normalized) || 0));
  }

  const placeholderText = typeof placeholder === "number" ? placeholder.toFixed(2) : placeholder ?? "0.00";
  return <label className="manual-field"><span className="manual-field-label">{label}</span><span className="manual-field-control"><input type="text" inputMode="decimal" placeholder={placeholderText} value={displayValue} onFocus={(event) => event.currentTarget.select()} onChange={(event) => updateValue(event.target.value)} onBlur={() => setDisplayValue(value === null ? "" : String(value))} disabled={disabled} aria-label={label} /><span>{suffix}</span></span>{note && <span className="manual-field-note manual-field-note-control">{note}</span>}</label>;
}

function PurchaseDateInput({ value, durationDays, disabled, onChange }: { value: string | null; durationDays: number; disabled: boolean; onChange: (value: string | null) => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedDate = parseCalendarDate(value);
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState(() => firstCalendarMonth(selectedDate ?? todayCalendarDate()));
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const maturity = value ? new Date(`${value}T00:00:00Z`) : null;
  maturity?.setUTCDate(maturity.getUTCDate() + durationDays);
  useDismissiblePopover(open, setOpen, buttonRef, menuRef);

  function toggleCalendar() {
    if (disabled) return;
    if (!open) {
      setVisibleMonth(firstCalendarMonth(selectedDate ?? todayCalendarDate()));
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) {
        const width = 280;
        const height = 338;
        const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
        const top = window.innerHeight - rect.bottom >= height || rect.top < height
          ? rect.bottom + 6
          : rect.top - height - 6;
        setPosition({ top, left });
      }
    }
    setOpen((current) => !current);
  }

  const calendarDays = calendarMonthDays(visibleMonth);
  const selectedValue = selectedDate ? calendarDateValue(selectedDate) : null;
  const todayValue = calendarDateValue(todayCalendarDate());
  const visibleMonthIndex = visibleMonth.getUTCMonth();

  return <div className="manual-field"><span className="manual-field-label">买入日</span><button ref={buttonRef} type="button" className={`manual-date-trigger ${value ? "" : "manual-date-trigger-empty"}`} aria-label="买入日" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={toggleCalendar}><span>{selectedDate ? calendarDateLabel(selectedDate) : "选择日期"}</span><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="4.5" width="14" height="12.5" rx="2" /><path d="M6.5 2.8v3.4M13.5 2.8v3.4M3 8h14" /></svg></button><span className="manual-field-note">{maturity && Number.isFinite(maturity.getTime()) ? `按 ${durationDays} 天自动计算：${formatShortDate(maturity.toISOString())} 到期` : `填写后按 ${durationDays} 天自动计算到期日`}</span>{open && createPortal(<div ref={menuRef} className="surface-popover calendar-popover" role="dialog" aria-label="选择买入日" style={{ top: position.top, left: position.left }}><div className="calendar-header"><button type="button" className="icon-button calendar-header-button" aria-label="上个月" onClick={() => setVisibleMonth((current) => shiftCalendarMonth(current, -1))}>‹</button><p>{visibleMonth.getUTCFullYear()} 年 {visibleMonthIndex + 1} 月</p><button type="button" className="icon-button calendar-header-button" aria-label="下个月" onClick={() => setVisibleMonth((current) => shiftCalendarMonth(current, 1))}>›</button></div><div className="calendar-weekdays" aria-hidden="true">{["一", "二", "三", "四", "五", "六", "日"].map((day) => <span key={day}>{day}</span>)}</div><div className="calendar-days" role="grid">{calendarDays.map((day) => { const dayValue = calendarDateValue(day); const outside = day.getUTCMonth() !== visibleMonthIndex; return <button key={dayValue} type="button" role="gridcell" aria-label={calendarDayAriaLabel(day)} aria-selected={dayValue === selectedValue} aria-current={dayValue === todayValue ? "date" : undefined} data-outside={outside ? "true" : undefined} onClick={() => { onChange(dayValue); setOpen(false); }}>{day.getUTCDate()}</button>; })}</div><div className="calendar-footer"><button type="button" disabled={!value} onClick={() => { onChange(null); setOpen(false); }}>清除</button><button type="button" onClick={() => { onChange(todayValue); setOpen(false); }}>今天</button></div></div>, document.body)}</div>;
}

function parseCalendarDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

function todayCalendarDate() {
  const today = new Date();
  return new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
}

function firstCalendarMonth(date: Date) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)); }
function shiftCalendarMonth(date: Date, offset: number) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1)); }
function calendarDateValue(date: Date) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`; }
function calendarDateLabel(date: Date) { return `${date.getUTCFullYear()} / ${String(date.getUTCMonth() + 1).padStart(2, "0")} / ${String(date.getUTCDate()).padStart(2, "0")}`; }
function calendarDayAriaLabel(date: Date) { return `${date.getUTCFullYear()} 年 ${date.getUTCMonth() + 1} 月 ${date.getUTCDate()} 日`; }
function calendarMonthDays(month: Date) {
  const firstWeekday = (month.getUTCDay() + 6) % 7;
  const start = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1 - firstWeekday));
  return Array.from({ length: 42 }, (_, index) => new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + index)));
}

function HoldingInput({ value, asset, disabled, onChange }: { value: number; asset: Asset; disabled: boolean; onChange: (value: number) => void }) {
  const [displayValue, setDisplayValue] = useState(value > 0 ? String(value) : "");

  function updateValue(nextValue: string) {
    const normalized = nextValue.replace(",", ".");
    if (!/^\d*(?:\.\d{0,8})?$/.test(normalized)) return;
    setDisplayValue(normalized);
    onChange(Math.max(0, Number(normalized) || 0));
  }

  return <label className="holding-editor holding-editor-editable"><span className="text-muted type-micro pointer-events-none font-medium">{asset}</span><input type="text" inputMode="decimal" placeholder="0.00" value={displayValue} onFocus={(event) => event.currentTarget.select()} onChange={(event) => updateValue(event.target.value)} onBlur={() => setDisplayValue(value > 0 ? String(value) : "")} disabled={disabled} aria-label={`${asset} 产品持仓`} className="type-body min-w-0 flex-1 bg-transparent text-left font-semibold tabular-nums outline-none disabled:opacity-60" /></label>;
}

function tierLabel(min: number, max: number | null) { return max === null ? `${formatAmount(min)} 以上` : `${formatAmount(min)}–${formatAmount(max)}`; }
function accountName(accountId: string) {
  const account = accounts.find((item) => item.id === accountId);
  if (!account) return accountId;
  return account.name;
}
function overflowFromFirstTier(product: Product, holding: number) { const firstTierMax = product.tiers[0]?.max; return firstTierMax === null || firstTierMax === undefined ? 0 : Math.max(0, holding - firstTierMax); }
function highestProductApr(product: Product) { return Math.max(0, ...product.tiers.map((tier) => tier.apr)); }
function standardProductName(product: Product) {
  if (product.manualKind === "limited") return "限时活期";
  if (product.productType === "fixed") return "定期理财";
  return "活期理财";
}
function fixedProductFacts(product: Product): Array<[string, string]> {
  const facts: Array<[string, string]> = [];
  const missingTerm = product.productDataMode === "manual" ? "待填写" : "待获取";
  if (product.manualKind === "limited") facts.push(["活动期限", product.termDays ? formatTerm(product.termDays) : missingTerm]);
  else facts.push(["锁定期限", product.termDays ? formatTerm(product.termDays) : missingTerm]);
  if (product.minimumAmount !== undefined) facts.push(["最低申购", `${formatAmount(product.minimumAmount)} ${product.asset}`]);
  if (product.subscriptionEndsAt) facts.push([
    Date.now() < Date.parse(product.subscriptionEndsAt) ? "认购截止" : "认购已截止",
    new Date(product.subscriptionEndsAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
  ]);
  if (product.eligibilityRequired) facts.push(["申购资格", product.eligibilityStatus === "ineligible" ? "账号不符合资格" : product.eligibilityLabel || "待确认"]);
  return facts;
}
function formatTerm(termDays: number) {
  if (termDays >= 1) return `${formatCompactNumber(termDays)} 天`;
  return `${formatCompactNumber(termDays * 24)} 小时`;
}

function formatCompactNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.0+$|(?<=\.[0-9])0+$/, "");
}

function formatSyncDateTime(value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function failureTarget(value: string) {
  const platformAssets: Record<string, Asset[]> = {
    "Binance.com": ["USDT", "USDC"],
    "Binance Bahrain": ["USDT", "USDC"],
    "Bybit.com": ["USDT", "USDC", "BTC"],
    "Bybit EU": ["USDT", "USDC"],
    Bitget: ["USDT", "USDC", "USDGO"],
    OKX: ["USDT", "USDC", "BTC"],
    MEXC: ["USDT", "USDC", "BTC"],
  };
  const platform = Object.keys(platformAssets).find((candidate) => value.startsWith(candidate));
  if (value.includes("交易所数据更新失败")) return "交易所";
  if (!platform) return value.replace(/（.*$/, "").trim();
  const failedAssets = platformAssets[platform].filter((asset) => value.includes(asset));
  return failedAssets.length > 0 && failedAssets.length < platformAssets[platform].length
    ? `${platform} ${failedAssets.join("/")}`
    : platform;
}

function isWholeUpdateFailure(value: string) {
  return value === "公开交易所" || value.includes("数据更新失败");
}

function nextScheduledRefreshAt(now: number) {
  const shanghaiOffsetMs = 8 * 60 * 60 * 1000;
  const local = new Date(now + shanghaiOffsetMs);
  const hour = local.getUTCHours();
  const targetHour = hour < 8 ? 8 : hour < 20 ? 20 : 8;
  if (hour >= 20) local.setUTCDate(local.getUTCDate() + 1);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), targetHour - 8)).toISOString();
}

function sameOverride(left?: ProductOverride, right?: ProductOverride) {
  return (left?.apr ?? null) === (right?.apr ?? null)
    && (left?.firstTierLimit ?? null) === (right?.firstTierLimit ?? null)
    && (left?.termDays ?? null) === (right?.termDays ?? null)
    && (left?.purchaseDate ?? null) === (right?.purchaseDate ?? null)
    && (left?.eligibilityConfirmed ?? null) === (right?.eligibilityConfirmed ?? null);
}

function sameManualProduct(left: Product, right?: Product) {
  return Boolean(right)
    && left.accountId === right!.accountId
    && left.asset === right!.asset
    && (left.manualKind ?? "flexible") === (right!.manualKind ?? "flexible")
    && (left.termDays ?? null) === (right!.termDays ?? null);
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
