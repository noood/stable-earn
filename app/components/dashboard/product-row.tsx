"use client";

import type { ReactNode } from "react";
import { ProductHistory, type ProductHistoryPage } from "@/app/components/product-history";
import { AccountBadge, HoldingSummary, TableCell } from "@/app/components/ui";
import { HoldingInput, InlineSelect, ManualAprInput, ManualLimitInput, ManualTermInput } from "@/app/components/dashboard/product-inputs";
import { PurchaseDateInput, parseCalendarDate } from "@/app/components/dashboard/purchase-date-input";
import { effectiveApr, formatAmount, type Account, type HoldingPosition, type HoldingSyncState, type Product, type ProductChangeEvent } from "@/lib/domain";
import { dateOnlyFromTimestamp, formatShortDate, productNeedsManualApr, productNeedsManualLimit, productNeedsManualTerm, productNeedsPurchaseDate, productTermDays, productTermStatus, type ProductOverride } from "@/lib/product-overrides";
import { holdingSyncNote, productCapacityIsIncomplete, productInformationIssues, productInformationNote, type ProductInformationIssue } from "@/lib/product-status";
import { apiFieldCapability } from "@/lib/api-capabilities";
import { rateHeadlineFor } from "@/lib/product-rate-presentation";
import { accounts } from "@/lib/seed-data";
import { hasCompletePurchaseTiming, type HoldingTiming } from "@/lib/holding-timing";

export type ManualProductPatch = { accountId?: string; manualKind?: Product["manualKind"]; termDays?: number };

export function ProductRow({ product, baseProduct, manualSettings, holdingTiming, holding, holdingAvailable, holdingSyncState, editing, editable, saving, manualProduct, apiDeleteDisabled, apiDeleteDisabledReason, rateFallbackAt, holdingFallbackAt, changeEvents, loadHistoryPage, readOnlyHistoryPreview = false, onEventsRead, onHoldingChange, onOverrideChange, onManualProductChange, onDelete }: { product: Product; baseProduct: Product; manualSettings?: ProductOverride; holdingTiming?: HoldingTiming; holding: number; holdingAvailable: boolean; holdingSyncState?: HoldingSyncState; editing: boolean; editable: boolean; saving: boolean; manualProduct: boolean; apiDeleteDisabled: boolean; apiDeleteDisabledReason?: string; rateFallbackAt?: string; holdingFallbackAt?: string; changeEvents: ProductChangeEvent[]; loadHistoryPage?: (cursor: string | null) => Promise<ProductHistoryPage>; readOnlyHistoryPreview?: boolean; onEventsRead: (readAt: string, eventIds: string[]) => void; onHoldingChange: (value: number) => void; onOverrideChange: (patch: Partial<ProductOverride>) => void; onManualProductChange: (patch: ManualProductPatch) => void; onDelete: () => void }) {
  const account = accounts.find((item) => item.id === product.accountId)!;
  const hasApiTiming = hasCompletePurchaseTiming(holdingTiming, holding);
  const productInfoIssues = productInformationIssues(product, manualSettings, hasApiTiming, holdingAvailable && holding > 0);
  return (
    <tr className={`product-row ${!editing && holdingAvailable && holding <= 0 ? "product-row-empty" : ""}`}>
      <TableCell>
        {editing && manualProduct
          ? <ManualProductIdentityEditor product={baseProduct} account={account} disabled={saving} onChange={onManualProductChange} onDelete={onDelete} />
          : <div className="flex items-start gap-3"><AccountBadge account={account} /><div className="min-w-0"><div className="type-body font-semibold">{account.name}</div><div className="text-muted type-caption mt-0.5 max-w-[220px] whitespace-normal break-words">{standardProductName(product)}</div>{editing && !manualProduct && <button type="button" className="manual-product-delete text-danger type-caption" disabled={saving || apiDeleteDisabled} title={apiDeleteDisabledReason} onClick={onDelete}>移除产品</button>}</div></div>}
      </TableCell>
      <TableCell><ProductTierSummary product={product} baseProduct={baseProduct} manualSettings={manualSettings} holdingTiming={holdingTiming} holding={holding} editing={editing} saving={saving} manualProduct={manualProduct} rateFallbackAt={rateFallbackAt} onOverrideChange={onOverrideChange} onManualProductChange={onManualProductChange} /></TableCell>
      <TableCell><ProductHolding product={product} account={account} holding={holding} holdingAvailable={holdingAvailable} holdingSyncState={holdingSyncState} editing={editing} editable={editable} saving={saving} holdingFallbackAt={holdingFallbackAt} productInfoIssues={productInfoIssues} onHoldingChange={onHoldingChange} /></TableCell>
      <TableCell className="type-body font-semibold tabular-nums">{holdingAvailable && productInfoIssues.length === 0 && holding > 0
        ? `${effectiveApr(product, holding).toFixed(2)}%`
        : <span className="text-subtle font-normal">—</span>}</TableCell>
      <TableCell className="product-history-cell"><ProductHistory productId={product.id} events={changeEvents} loadPage={loadHistoryPage} onEventsRead={onEventsRead} readOnlyPreview={readOnlyHistoryPreview} /></TableCell>
    </tr>
  );
}

function ManualProductIdentityEditor({ product, account, disabled, onChange, onDelete }: { product: Product; account: Account; disabled: boolean; onChange: (patch: ManualProductPatch) => void; onDelete: () => void }) {
  return <div className="flex items-start gap-3"><AccountBadge account={account} /><div className="manual-identity-fields min-w-0 flex-1"><InlineSelect className="inline-select-trigger-primary" ariaLabel="平台" value={product.accountId} options={accounts.map((item) => ({ value: item.id, label: item.name }))} disabled={disabled} onChange={(accountId) => onChange({ accountId })} /><InlineSelect className="inline-select-trigger-secondary" ariaLabel="产品类型" value={product.manualKind ?? "flexible"} options={[{ value: "flexible", label: "活期理财" }, { value: "fixed", label: "定期理财" }, { value: "limited", label: "限时活期" }]} disabled={disabled} onChange={(manualKind) => onChange({ manualKind: manualKind as Product["manualKind"] })} /><button type="button" className="manual-product-delete text-danger type-caption" disabled={disabled} onClick={onDelete}>移除产品</button></div></div>;
}

function ProductTierSummary({ product, baseProduct, manualSettings, holdingTiming, holding, editing, saving, manualProduct, rateFallbackAt, onOverrideChange, onManualProductChange }: { product: Product; baseProduct: Product; manualSettings?: ProductOverride; holdingTiming?: HoldingTiming; holding: number; editing: boolean; saving: boolean; manualProduct: boolean; rateFallbackAt?: string; onOverrideChange: (patch: Partial<ProductOverride>) => void; onManualProductChange: (patch: ManualProductPatch) => void }) {
  const manualApr = productNeedsManualApr(baseProduct);
  const manualLimit = productNeedsManualLimit(baseProduct);
  const manualTerm = productNeedsManualTerm(baseProduct);
  // Historical manual catalog rows may omit manualKind. Treat an omitted
  // kind as flexible, matching the editor's default, instead of showing a
  // fixed-term input for every old flexible product.
  const manualKind = baseProduct.manualKind ?? "flexible";
  const manualProductTerm = manualProduct && manualKind !== "flexible";
  const fixedFacts = product.productType === "fixed" || product.manualKind === "limited" ? fixedProductFacts(product) : [];
  const qualificationFact = product.eligibilityRequired ? qualificationLabel(product) : null;
  const durationDays = productTermDays(product);
  const apiManaged = baseProduct.productDataMode === "api";
  const holdingPosition = holdingTiming?.singlePosition;
  const hasApiTiming = hasCompletePurchaseTiming(holdingTiming, holding);
  const apiTiming = (hasApiTiming || holding <= 0) && holdingPosition && (holdingPosition.purchaseAt || holdingPosition.redeemAt) ? holdingPosition : undefined;
  const apiPurchaseDate = apiTiming?.purchaseAt ? dateOnlyFromTimestamp(apiTiming.purchaseAt) : null;
  const apiDateSupported = apiManaged && apiFieldCapability(product, "purchaseAt") === "supported";
  const showManualPurchaseDate = !apiDateSupported && productNeedsPurchaseDate(product) && Boolean(durationDays);
  const showManualFields = manualApr || manualLimit || manualTerm || manualProductTerm || showManualPurchaseDate;
  const multipleApiPositions = apiDateSupported && (holdingTiming?.positions.length ?? 0) > 1;
  const termStatus = productTermStatus(product, manualSettings?.purchaseDate);
  const productInfoIssues = productInformationIssues(product, manualSettings, hasApiTiming, holding > 0);
  const rateHeadline = rateHeadlineFor(product, apiManaged);
  const cacheNotes = [
    rateFallbackAt && product.rateCoverage !== "unavailable"
      ? `产品信息沿用 ${formatSyncDateTime(rateFallbackAt)} 的缓存数据`
      : null,
    product.aprSource === "cache" && product.aprFetchedAt
      ? `APR 沿用 ${formatSyncDateTime(product.aprFetchedAt)} 的缓存数据`
      : null,
    product.capacitySource === "cache" && product.capacityFetchedAt
      ? `额度沿用 ${formatSyncDateTime(product.capacityFetchedAt)} 的缓存数据`
      : null,
  ].filter((note): note is string => Boolean(note));
  const sourceText = cacheNotes.length > 0
    ? cacheNotes.join("；")
    : productInfoIssues.length === 0 && apiManaged && editing ? "API 同步" : "";
  const termStatusText: ReactNode = multipleApiPositions
    ? hasApiTiming ? "各笔到期日请在交易所查看" : "到期日未获取"
    : apiTiming
    ? apiTermLifecycleText(product, apiTiming)
    : termStatus
      ? termStatus.remainingDays > 0
        ? <>预计 {formatShortDate(termStatus.maturityDate)} 到期</>
        : <>已于 {formatShortDate(termStatus.maturityDate)} 到期</>
      : "";
  const incompleteText = productInfoIssues.length > 0 ? productInformationNote(productInfoIssues) : "";
  const lifecycleDate = apiDateSupported ? apiPurchaseDate : manualSettings?.purchaseDate ?? null;
  const lifecycleDateLabel = multipleApiPositions
    ? hasApiTiming ? "多笔持仓" : "部分未获取"
    : lifecycleDate
    ? formatFactDate(lifecycleDate)
    : apiDateSupported ? "未获取" : "待填写";
  const showLifecycleFact = Boolean(durationDays) && (!editing || (apiManaged && apiDateSupported));
  const apiMaturity = apiTiming
    ? apiTiming.redeemAt
      ?? (apiTiming.purchaseAt && durationDays ? new Date(Date.parse(apiTiming.purchaseAt) + durationDays * 24 * 60 * 60 * 1000).toISOString() : undefined)
    : undefined;
  const lifecycleStatusWarning = apiMaturity
    ? apiMaturityIsPast(apiMaturity)
    : Boolean(termStatus && termStatus.remainingDays <= 0);
  const lifecycleValue = <>{lifecycleDateLabel}{termStatusText && <><span className="product-fact-separator">｜</span><span className={lifecycleStatusWarning ? "product-fact-danger" : "product-fact-note"}>{termStatusText}</span></>}</>;

  return <div className="space-y-1.5"><ProductRateHeadline {...rateHeadline} />
    {(!editing || !manualProduct) && fixedFacts.map(([label, value]) => <ProductFact key={label} label={label} value={value} />)}
    {(!editing || !manualProduct) && qualificationFact && <ProductFact label="申购资格" value={qualificationFact} />}
    {showLifecycleFact && <ProductFact label="买入日期" value={lifecycleValue} />}
    {!editing && manualTerm && <ProductFact label="活动期限" value={durationDays ? formatTerm(durationDays) : "待填写"} />}
    {sourceText && <ProductMeta text={sourceText} danger={Boolean(rateFallbackAt || product.aprSource === "cache" || product.capacitySource === "cache")} />}
    {incompleteText && <ProductMeta text={incompleteText} danger={product.rateCoverage === "partial" || holding > 0 || productInfoIssues.some((issue) => issue.endsWith("未获取"))} />}
    {editing && showManualFields && <div className="manual-fields">
      {manualLimit && <ManualLimitInput value={manualSettings?.firstTierLimit ?? null} asset={product.asset} disabled={saving} onChange={(firstTierLimitValue) => onOverrideChange({ firstTierLimit: firstTierLimitValue })} />}
      {manualApr && <ManualAprInput value={manualSettings?.apr ?? null} disabled={saving} onChange={(apr) => onOverrideChange({ apr })} />}
      {manualTerm && <ManualTermInput label="活动期限" value={manualSettings?.termDays ?? null} disabled={saving} onChange={(termDays) => onOverrideChange({ termDays })} />}
      {manualProductTerm && <ManualTermInput label={manualKind === "limited" ? "活动期限" : "锁定期限"} value={baseProduct.termDays ?? null} disabled={saving} onChange={(termDays) => onManualProductChange({ termDays: termDays ?? undefined })} />}
      {showManualPurchaseDate && durationDays && <PurchaseDateInput value={manualSettings?.purchaseDate ?? null} durationDays={durationDays} disabled={saving} onChange={(purchaseDate) => onOverrideChange({ purchaseDate })} />}
    </div>}
  </div>;
}

function ProductMeta({ text, title, danger = false }: { text: ReactNode; title?: string; danger?: boolean }) {
  const resolvedTitle = title ?? (typeof text === "string" ? text : undefined);
  return <p className={`product-meta ${danger ? "product-meta-danger" : "text-muted"}`} title={resolvedTitle}>{text}</p>;
}

function apiTermLifecycleText(product: Product, position: HoldingPosition): ReactNode {
  const maturity = position.redeemAt
    ?? (position.purchaseAt && productTermDays(product)
      ? new Date(Date.parse(position.purchaseAt) + productTermDays(product)! * 24 * 60 * 60 * 1000).toISOString()
      : undefined);
  if (!maturity || !Number.isFinite(Date.parse(maturity))) return "到期日未获取";
  return Date.parse(maturity) > Date.now()
    ? <>预计 {formatShortDate(maturity)} 到期</>
    : <>已于 {formatShortDate(maturity)} 到期</>;
}

function apiMaturityIsPast(value: string) {
  return Date.parse(value) <= Date.now();
}

function ProductRateHeadline({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return <div className="product-rate-headline"><span>{label}</span><span className={`status-chip ${muted ? "status-chip-muted" : "status-chip-highlight"}`}>{value}</span></div>;
}

function ProductFact({ label, value }: { label: string; value: ReactNode }) {
  return <div className="product-fact"><span>{label}</span><span className="tabular-nums">{value}</span></div>;
}

function formatFactDate(value: string) {
  const parsed = parseCalendarDate(value);
  return parsed ? `${parsed.getUTCFullYear()}/${String(parsed.getUTCMonth() + 1).padStart(2, "0")}/${String(parsed.getUTCDate()).padStart(2, "0")}` : "待获取";
}

function ProductHolding({ product, account, holding, holdingAvailable, holdingSyncState, editing, editable, saving, holdingFallbackAt, productInfoIssues, onHoldingChange }: { product: Product; account: Account; holding: number; holdingAvailable: boolean; holdingSyncState?: HoldingSyncState; editing: boolean; editable: boolean; saving: boolean; holdingFallbackAt?: string; productInfoIssues: ProductInformationIssue[]; onHoldingChange: (value: number) => void }) {
  const firstTier = product.tiers[0];
  const firstTierCapacity = firstTier?.max == null ? null : firstTier.max - firstTier.min;
  const usedInFirstTier = firstTierCapacity === null ? holding : Math.max(0, Math.min(firstTierCapacity, holding - firstTier.min));
  const firstTierProgress = firstTierCapacity ? Math.min(100, usedInFirstTier / firstTierCapacity * 100) : 100;
  const overflow = overflowFromFirstTier(product, holding);
  const nextApr = product.tiers[1]?.apr;
  const capacityLabel = product.productType === "fixed" ? "申购额度" : "首档";
  const capacityIncomplete = productCapacityIsIncomplete(product, productInfoIssues);
  const laterTierIncomplete = productInfoIssues.some((issue) => issue === "阶梯 APR 未获取" || issue === "阶梯结构未获取" || issue === "阶梯额度未获取");
  const holdingAmountClassName = editing ? undefined : "holding-summary-amount";
  const holdingDetailClassName = editing ? undefined : "holding-summary-detail";
  const holdingLabel = (detail?: string) => <><span className={holdingAmountClassName}>持仓 {formatAmount(holding)}</span>{detail && <span className={holdingDetailClassName}> / {detail}</span>}</>;
  const holdingCacheNote = holdingFallbackAt ? `持仓沿用 ${formatSyncDateTime(holdingFallbackAt)} 的缓存数据` : undefined;

  let summary: ReactNode = null;
  if (!holdingAvailable) {
    summary = <HoldingSummary muted compact label={editing ? undefined : <span className={holdingAmountClassName}>持仓未获取</span>} note={holdingSyncNote(holdingSyncState)} />;
  } else if (capacityIncomplete) {
    // A missing first-tier boundary hides dependent quota details. Missing
    // dates or later-tier details do not hide a known first-tier limit.
    summary = editing
      ? (holdingCacheNote ? <HoldingSummary muted compact cacheNote={holdingCacheNote} /> : null)
      : <HoldingSummary compact label={holdingLabel()} cacheNote={holdingCacheNote} />;
  } else if (firstTierCapacity === null) {
    summary = <HoldingSummary compact label={holdingLabel(`${capacityLabel}不限额`)} cacheNote={holdingCacheNote} />;
  } else {
    const note = overflow > 0
      ? `超出${capacityLabel} +${formatAmount(overflow)} ${product.asset}${laterTierIncomplete ? " · 后续档位待确认" : nextApr !== undefined ? ` · 按 ${nextApr.toFixed(2)}%` : " · 不再计入本产品"}`
      : `${product.productType === "fixed" ? "还可申购" : "还可放"} ${formatAmount(Math.max(0, firstTierCapacity - usedInFirstTier))} ${product.asset}`;
    summary = <HoldingSummary label={holdingLabel(`${capacityLabel} ${formatAmount(firstTierCapacity)}`)} cacheNote={holdingCacheNote} note={note} progress={firstTierProgress} progressLabel={`${account.name} ${capacityLabel}使用进度`} noteTone={overflow > 0 ? "danger" : "default"} compact={editing} />;
  }

  return <div className="holding-column">{editing && (editable
    ? <HoldingInput value={holding} asset={product.asset} disabled={saving} onChange={onHoldingChange} />
    : <div className="holding-editor holding-editor-readonly"><span className="text-muted flex items-baseline gap-2"><span className="type-micro font-normal">{product.asset}</span><span className="type-body font-normal tabular-nums">{holdingAvailable ? formatAmount(holding) : "未获取"}</span></span>{holdingAvailable && !holdingFallbackAt && <span className="text-muted type-micro">API 同步</span>}</div>)}{summary}</div>;
}

export function overflowFromFirstTier(product: Product, holding: number) { const firstTierMax = product.tiers[0]?.max; return firstTierMax === null || firstTierMax === undefined ? 0 : Math.max(0, holding - firstTierMax); }
function standardProductName(product: Product) {
  if (product.manualKind === "limited") return "限时活期";
  if (product.productType === "fixed") return "定期理财";
  return "活期理财";
}
function qualificationLabel(product: Product) {
  if (product.eligibilityStatus === "ineligible") return "账号不符合资格";
  if (product.eligibilityStatus === "eligible") return product.eligibilityLabel || "账号符合资格";
  return product.eligibilityLabel ? `${product.eligibilityLabel} · 待确认` : "待确认";
}
function fixedProductFacts(product: Product): Array<[string, string]> {
  const facts: Array<[string, string]> = [];
  const missingTerm = product.productDataMode === "manual" ? "待填写" : "未获取";
  if (product.manualKind === "limited") facts.push(["活动期限", product.termDays ? formatTerm(product.termDays) : missingTerm]);
  else facts.push(["锁定期限", product.termDays ? formatTerm(product.termDays) : missingTerm]);
  if (product.minimumAmount !== undefined) facts.push(["最低申购", `${formatAmount(product.minimumAmount)} ${product.asset}`]);
  if (product.subscriptionEndsAt) facts.push([
    Date.now() < Date.parse(product.subscriptionEndsAt) ? "认购截止" : "认购已截止",
    new Date(product.subscriptionEndsAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
  ]);
  return facts;
}
function formatTerm(termDays: number) {
  if (termDays >= 1) return `${formatCompactNumber(termDays)} 天`;
  return `${formatCompactNumber(termDays * 24)} 小时`;
}

function formatCompactNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.0+$|(?<=\.[0-9])0+$/, "");
}

export function formatSyncDateTime(value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
