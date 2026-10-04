import { Dashboard } from "@/app/page";
import type { Asset } from "@/lib/domain";

// The private dashboard is user-scoped and consumes URL search parameters.
export const dynamic = "force-dynamic";

type PrivateIndexPageProps = {
  searchParams?: Promise<{ asset?: string | string[] }>;
};

function parseAsset(value: string | string[] | undefined): Asset {
  const candidate = (Array.isArray(value) ? value[0] : value)?.toUpperCase();
  return candidate === "USDT" || candidate === "USDC" || candidate === "USDGO" || candidate === "BTC"
    ? candidate
    : "USDT";
}

export default async function PrivateIndexPage({ searchParams }: PrivateIndexPageProps) {
  const params = await searchParams;
  return <Dashboard mode="private" initialAsset={parseAsset(params?.asset)} localPreview={process.env.NODE_ENV === "development"} />;
}
