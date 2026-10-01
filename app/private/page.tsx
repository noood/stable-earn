"use client";

import { Dashboard } from "@/app/page";

export default function PrivateIndexPage() {
  return <Dashboard mode="private" localPreview={process.env.NODE_ENV === "development"} />;
}
