"use client";

import { Dashboard } from "@/app/page";

export default function PrivateDashboardPage() {
  return <Dashboard mode="private" localPreview={process.env.NODE_ENV === "development"} />;
}
