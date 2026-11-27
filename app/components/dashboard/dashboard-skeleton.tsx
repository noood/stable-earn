"use client";

import { ActionButton, Metric, MetricsPanel, MetricSkeleton, TableCell } from "@/app/components/ui";
import { DashboardFooter, DashboardPageFrame, DashboardProductTableSection, DashboardSyncNotice, NavigationMenuPlaceholder, ProductTableEmptyState } from "@/app/components/dashboard/dashboard-frame";
import type { Asset } from "@/lib/domain";
import { minimumOpportunityApr } from "@/lib/opportunity-policy";

export const metricDescriptions = {
  portfolioApr: "按各阶梯实际占用加权",
  dailyIncome: "按可用 APR 和实际档位计算",
  highYieldLeft: `APR ≥ ${minimumOpportunityApr}% 各档已知剩余额度`,
};

export function DashboardMetricsSkeleton({ asset = null }: { asset?: Asset | null } = {}) {
  const metrics = [
    { label: asset ? `总持仓 · ${asset}` : undefined },
    { label: "组合有效 APR", description: metricDescriptions.portfolioApr },
    { label: asset ? `预计每日收益 · ${asset}` : undefined, description: metricDescriptions.dailyIncome },
    { label: "最佳首档 APR" },
    { label: "高息剩余额度", description: metricDescriptions.highYieldLeft },
    { label: "超出首档" },
  ];
  return <>{metrics.map((metric, index) => <MetricSkeleton key={metric.label ?? index} highlight={index === 0} {...metric} />)}</>;
}

export function ProductTableSkeletonRows() {
  const widths = ["72%", "84%", "90%", "48%", "30%"];
  return <>{Array.from({ length: 3 }, (_, row) => <tr key={row} className="product-row" aria-hidden="true">{widths.map((width, column) => <TableCell key={column}><span className="skeleton-block skeleton-table-line" style={{ width }} /></TableCell>)}</tr>)}</>;
}

export function DashboardModuleSkeleton({ asset = null, onAssetChange }: { asset?: Asset | null; onAssetChange?: (asset: Asset) => void } = {}) {
  return (
    <DashboardPageFrame asset={asset} onAssetChange={onAssetChange}>
      <div className="page-width dashboard-content mx-auto">
        <DashboardSyncNotice busy icon="clock">
          <span className="skeleton-block h-4 w-2/3" aria-hidden="true" />
        </DashboardSyncNotice>

        <MetricsPanel aria-busy="true" aria-label="账户指标正在准备">
          <DashboardMetricsSkeleton asset={asset} />
        </MetricsPanel>

        <DashboardProductTableSection
          sectionBusy
          title={asset
            ? <h2 className="type-title font-semibold tracking-[-0.02em]">{asset} 持仓</h2>
            : <div className="type-title font-semibold tracking-[-0.02em]" aria-hidden="true"><span className="skeleton-block inline-block h-6 w-28 align-middle" /></div>}
          subtitle={<span className="skeleton-block h-4 w-64 max-w-full" aria-hidden="true" />}
          actions={<ActionButton variant="primary" disabled>编辑持仓</ActionButton>}
        >
          <ProductTableSkeletonRows />
        </DashboardProductTableSection>
        <DashboardFooter />
      </div>
    </DashboardPageFrame>
  );
}

export function DashboardModuleFailure({ asset = null, onAssetChange }: { asset?: Asset | null; onAssetChange?: (asset: Asset) => void }) {
  return (
    <DashboardPageFrame asset={asset} onAssetChange={onAssetChange} menu={<NavigationMenuPlaceholder />}>
      <div className="page-width dashboard-content mx-auto">
        <DashboardSyncNotice alert icon="bell">
          <p className="text-danger">页面加载失败，数据无法显示，请刷新页面。</p>
        </DashboardSyncNotice>

        <MetricsPanel aria-label="账户指标暂不可用">
          <Metric highlight label={asset ? `总持仓 · ${asset}` : "总持仓"} value="—" note="加载失败" />
          <Metric label="组合有效 APR" description={metricDescriptions.portfolioApr} value="—" note="加载失败" />
          <Metric label={asset ? `预计每日收益 · ${asset}` : "预计每日收益"} description={metricDescriptions.dailyIncome} value="—" note="加载失败" />
          <Metric label="最佳首档 APR" value="—" note="加载失败" />
          <Metric label="高息剩余额度" description={metricDescriptions.highYieldLeft} value="—" note="加载失败" />
          <Metric label="超出首档" value="—" note="加载失败" />
        </MetricsPanel>

        <DashboardProductTableSection
          title={<h2 className="type-title font-semibold tracking-[-0.02em]">{asset ? `${asset} 持仓` : "持仓"}</h2>}
          subtitle={<p className="table-toolbar-subtitle text-muted type-caption">持仓信息加载失败</p>}
          actions={<ActionButton variant="primary" disabled>编辑持仓</ActionButton>}
        >
          <tr><td colSpan={5}><ProductTableEmptyState message="页面加载失败，数据无法显示，请刷新页面。" /></td></tr>
        </DashboardProductTableSection>
        <DashboardFooter />
      </div>
    </DashboardPageFrame>
  );
}
