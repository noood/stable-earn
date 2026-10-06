"use client";

import dynamic from "next/dynamic";

const PrivateDashboard = dynamic(
  () => import("@/app/page").then((module) => module.Dashboard),
  {
    ssr: false,
    loading: () => (
      <main className="min-h-screen" aria-busy="true">
        <div className="page-width mx-auto px-5 py-5 lg:px-10 lg:py-6">
          <div className="card type-caption flex items-center gap-3 px-5 py-4" role="status">
            <svg className="sync-notice-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="8.5" />
              <path d="M12 7.5V12l3 2" />
            </svg>
            <span className="text-muted">正在加载个人数据…</span>
          </div>
        </div>
      </main>
    ),
  },
);

export default function PrivateDashboardClient() {
  return <PrivateDashboard mode="private" localPreview={process.env.NODE_ENV === "development"} />;
}
