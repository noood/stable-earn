import { accounts, seedProducts } from "./seed-data";

const assets = ["USDT", "USDC", "USDGO", "BTC"] as const;

export function filterFallbacksByFailures(fallbacks: Record<string, string>, failures: string[]) {
  if (failures.length === 0) return {};
  return Object.fromEntries(Object.entries(fallbacks).filter(([productId]) => {
    const product = seedProducts.find((candidate) => candidate.id === productId);
    if (!product) return true;
    const account = accounts.find((candidate) => candidate.id === product.accountId);
    if (!account) return true;
    return failures.some((failure) => {
      const namedAccounts = accounts.filter((candidate) => failure.includes(candidate.name));
      if (namedAccounts.length === 0) return true;
      if (!failure.includes(account.name)) return false;
      const namedAssets = assets.filter((asset) => failure.includes(asset));
      return namedAssets.length === 0 || namedAssets.includes(product.asset);
    });
  }));
}
