"use client";

import Image from "next/image";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Asset } from "@/lib/domain";

const assets: Asset[] = ["USDT", "USDC", "USDGO", "BTC"];

export function DashboardPageFrame({
  asset,
  onAssetChange,
  menu,
  children,
}: {
  asset: Asset | null;
  onAssetChange?: (asset: Asset) => void;
  menu?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen">
      <DashboardNavigation asset={asset} onAssetChange={onAssetChange} menu={menu} />
      {children}
    </main>
  );
}

export function DashboardNavigation({
  asset,
  onAssetChange,
  menu,
}: {
  asset: Asset | null;
  onAssetChange?: (asset: Asset) => void;
  menu?: ReactNode;
}) {
  return (
    <nav className="top-nav sticky top-0 z-20" aria-label="主导航">
      <div className="page-width mx-auto">
        <div className="flex min-h-14 flex-wrap items-center gap-x-4 px-1 sm:min-h-18 sm:flex-nowrap">
          <div className="flex shrink-0 items-center py-2"><p className="text-lg/6 font-semibold tracking-[-0.025em]">Stable Earn</p></div>
          <div className="order-3 h-11 w-full min-w-0 self-stretch sm:order-none sm:ml-8 sm:h-14 sm:w-auto sm:self-center">
            <AssetSwitch asset={asset} onChange={onAssetChange} />
          </div>
          {menu ?? <NavigationMenuPlaceholder />}
        </div>
      </div>
    </nav>
  );
}

export function NavigationMoreIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <circle cx="3.5" cy="10" r="1.5" />
      <circle cx="10" cy="10" r="1.5" />
      <circle cx="16.5" cy="10" r="1.5" />
    </svg>
  );
}

export function NavigationMenuPlaceholder() {
  return <div className="ml-auto flex items-center justify-end py-2"><button type="button" className="icon-button action-menu-trigger" aria-label="更多操作，页面功能加载中" disabled><NavigationMoreIcon /></button></div>;
}

export function DashboardFooter() {
  return <footer className="site-footer text-muted type-caption"><p>数据仅用于监控与比较，不构成投资建议。实际到账以平台账户为准。</p><a className="github-footer-link" href="https://github.com/noood/stable-earn" target="_blank" rel="noreferrer" aria-label="GitHub 源码仓库" title="GitHub 源码仓库"><Image src="/GitHub_Lockup_Black_Clearspace.svg" width={448} height={127} alt="" aria-hidden="true" /></a></footer>;
}

export function DashboardSyncNotice({ children, actions, busy, alert = false }: {
  children: ReactNode;
  actions?: ReactNode;
  busy?: boolean;
  alert?: boolean;
}) {
  return (
    <div className="sync-notice type-caption" role={alert ? "alert" : undefined} aria-live={alert ? "assertive" : "polite"} aria-busy={busy}>
      <div className="sync-notice-copy">
        <svg className="sync-notice-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" />
        </svg>
        {children}
      </div>
      {actions}
    </div>
  );
}

function ProductTableColumns() {
  return <colgroup><col className="product-table-col-platform" /><col className="product-table-col-rate" /><col className="product-table-col-holding" /><col className="product-table-col-effective" /><col className="product-table-col-history" /></colgroup>;
}

function ProductTableHeader() {
  return <thead><tr><th>平台与产品类型</th><th>产品信息</th><th>持仓与额度使用</th><th>有效 APR</th><th>变更</th></tr></thead>;
}

export function DashboardProductTableSection({
  title,
  subtitle,
  actions,
  children,
  notice,
  sectionBusy,
  tableBusy,
}: {
  title: ReactNode;
  subtitle: ReactNode;
  actions: ReactNode;
  children: ReactNode;
  notice?: ReactNode;
  sectionBusy?: boolean;
  tableBusy?: boolean;
}) {
  return <section className="card overflow-hidden" aria-busy={sectionBusy}>
    <div className="table-toolbar">
      <div className="table-toolbar-copy">{title}{subtitle}</div>
      <div className="table-toolbar-actions flex shrink-0 items-center gap-2">{actions}</div>
    </div>
    {notice}
    <div className="overflow-x-auto"><table className="product-table type-body" aria-busy={tableBusy}>
      <ProductTableColumns />
      <ProductTableHeader />
      <tbody>{children}</tbody>
    </table></div>
  </section>;
}

export function ProductTableEmptyState({ message = "吸引人的稳定理财尚未出现！" }: { message?: string }) {
  return <div className="empty-product-state"><p className="text-muted type-label font-semibold">{message}</p></div>;
}

function AssetSwitch({ asset, onChange }: { asset: Asset | null; onChange?: (asset: Asset) => void }) {
  const selectedTab = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const tab = selectedTab.current;
    const strip = tab?.parentElement;
    if (!tab || !strip) return;

    const revealTab = () => {
      const bounds = strip.getBoundingClientRect();
      const current = tab.getBoundingClientRect();
      if (current.left < bounds.left) strip.scrollLeft += current.left - bounds.left;
      else if (current.right > bounds.right) strip.scrollLeft += current.right - bounds.right;
    };

    revealTab();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(revealTab);
    observer?.observe(strip);
    observer?.observe(tab);
    window.addEventListener("pageshow", revealTab);
    return () => {
      observer?.disconnect();
      window.removeEventListener("pageshow", revealTab);
    };
  }, [asset]);

  return <div className="asset-switch inline-flex h-full w-fit max-w-full flex-nowrap items-stretch gap-1">
    {assets.map((item) => <button key={item} ref={asset === item ? selectedTab : undefined} type="button" disabled={!onChange} onClick={() => onChange?.(item)} aria-current={asset === item ? "page" : undefined} className="asset-tab type-label flex shrink-0 items-center gap-2 font-semibold transition-colors"><AssetIcon asset={item} /><span>{item}</span></button>)}
  </div>;
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
