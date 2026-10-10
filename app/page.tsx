"use client";

import { useEffect, useState } from "react";
import { Dashboard } from "@/app/components/dashboard/dashboard";

// The public landing page is the same for everyone; account state is loaded
// client-side from the private session endpoint after hydration.
export const dynamic = "force-static";

export default function Home() {
  const [publicPage, setPublicPage] = useState(process.env.NODE_ENV === "development");

  useEffect(() => {
    if (process.env.NODE_ENV === "development") return;
    let active = true;
    void fetch("/private/api/session", { cache: "no-store", redirect: "manual" })
      .then((response) => {
        if (!active) return;
        const contentType = response.headers.get("content-type") ?? "";
        if (response.ok && contentType.includes("application/json")) {
          const url = new URL(window.location.href);
          url.pathname = "/private";
          window.location.replace(`${url.pathname}${url.search}${url.hash}`);
          return;
        }
        setPublicPage(true);
      })
      .catch(() => {
        if (active) setPublicPage(true);
      });
    return () => { active = false; };
  }, []);

  if (!publicPage) return <main className="min-h-screen" aria-busy="true" />;
  return <Dashboard mode="demo" />;
}
