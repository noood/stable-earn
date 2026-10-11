"use client";

import { ActionButton, Metric, MetricSkeleton, TableCell } from "@/app/components/ui";
import { DashboardFooter, DashboardPageFrame, NavigationMenuPlaceholder, ProductTableColumns, ProductTableEmptyState, ProductTableHeader } from "@/app/components/dashboard/dashboard-frame";
import type { Asset } from "@/lib/domain";

export function DashboardMetricsSkeleton() {
  return <>{Array.from({ length: 6 }, (_, index) => <MetricSkeleton key={index} highlight={index === 0} />)}</>;
}

export function ProductTableSkeletonRows() {
  const widths = ["72%", "84%", "90%", "48%", "30%"];
  return <>{Array.from({ length: 3 }, (_, row) => <tr key={row} className="product-row" aria-hidden="true">{widths.map((width, column) => <TableCell key={column}><span className="skeleton-block skeleton-table-line" style={{ width }} /></TableCell>)}</tr>)}</>;
}

export function DashboardModuleSkeleton({ asset = null, onAssetChange }: { asset?: Asset | null; onAssetChange?: (asset: Asset) => void } = {}) {
  return (
    <DashboardPageFrame asset={asset} onAssetChange={onAssetChange}>
      <div className="page-width mx-auto px-5 py-5 lg:px-10 lg:py-6">
        <div className="card type-caption mb-4 flex items-center justify-between gap-4 px-5 py-4" aria-live="polite" aria-busy="true">
          <div className="sync-notice-copy flex min-w-0 flex-1 items-start gap-2"><span className="skeleton-block sync-notice-icon h-4 w-4 rounded-full" aria-hidden="true" /><span className="skeleton-block h-4 w-2/3" /></div>
        </div>

        <section className="metrics-panel card mb-4 grid overflow-hidden sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6" aria-busy="true" aria-label="账户指标正在准备">
          <DashboardMetricsSkeleton />
        </section>

        <section className="card overflow-hidden" aria-busy="true">
          <div className="table-toolbar">
            <div className="table-toolbar-copy">
              <h2 className="type-title font-semibold tracking-[-0.02em]">持仓</h2>
              <span className="skeleton-block h-4 w-64 max-w-full" />
            </div>
            <span className="skeleton-block h-10 w-28 rounded-xl" />
          </div>
          <div className="overflow-x-auto">
            <table className="product-table type-body">
              <ProductTableColumns />
              <ProductTableHeader />
              <tbody><ProductTableSkeletonRows /></tbody>
            </table>
          </div>
        </section>
        <DashboardFooter />
      </div>
    </DashboardPageFrame>
  );
}

export function DashboardModuleFailure({ asset = null, onAssetChange }: { asset?: Asset | null; onAssetChange?: (asset: Asset) => void }) {
  return (
    <DashboardPageFrame asset={asset} onAssetChange={onAssetChange} menu={<NavigationMenuPlaceholder />}>
      <div className="page-width mx-auto px-5 py-5 lg:px-10 lg:py-6">
        <div className="card type-caption mb-4 flex items-center gap-4 px-5 py-4" role="alert" aria-live="assertive">
          <div className="sync-notice-copy flex min-w-0 flex-1 items-start gap-2">
            <svg className="sync-notice-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
            <p className="text-danger font-semibold">页面加载失败，数据无法显示，请刷新页面。</p>
          </div>
        </div>

        <section className="metrics-panel card mb-4 grid overflow-hidden sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6" aria-label="账户指标暂不可用">
          <Metric highlight label="总持仓" value="—" note="加载失败" />
          <Metric label="组合有效 APR" value="—" note="加载失败" />
          <Metric label="预计每日收益" value="—" note="加载失败" />
          <Metric label="最佳首档 APR" value="—" note="加载失败" />
          <Metric label="高息剩余额度" value="—" note="加载失败" />
          <Metric label="超出首档" value="—" note="加载失败" />
        </section>

        <section className="card overflow-hidden">
          <div className="table-toolbar">
            <div className="table-toolbar-copy"><h2 className="type-title font-semibold tracking-[-0.02em]">持仓</h2><p className="table-toolbar-subtitle text-muted type-caption">持仓信息加载失败</p></div>
            <ActionButton variant="primary" disabled>编辑持仓</ActionButton>
          </div>
          <div className="overflow-x-auto">
            <table className="product-table type-body"><ProductTableColumns /><ProductTableHeader /><tbody><tr><td colSpan={5}><ProductTableEmptyState message="页面加载失败，数据无法显示，请刷新页面。" /></td></tr></tbody></table>
          </div>
        </section>
        <DashboardFooter />
      </div>
    </DashboardPageFrame>
  );
}
