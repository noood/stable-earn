/** User-visible labels only; account identities and API capabilities stay separate. */
export const accountDisplayNames = {
  "binance-global": "Binance Global",
  "binance-bahrain": "Binance Bahrain",
  "bybit-global": "Bybit Global",
  "bybit-eu": "Bybit EU",
  "bitget-global": "Bitget",
  "okx-global": "OKX",
  "mexc-ph": "MEXC · PH 🇵🇭",
  "mexc-uk": "MEXC · UK 🇬🇧",
} as const;

/** Capability reports combine the two MEXC markets and keep regions separately. */
export function capabilityPlatformName(accountId: string) {
  if (accountId === "mexc-ph" || accountId === "mexc-uk") return "MEXC";
  return accountDisplayNames[accountId as keyof typeof accountDisplayNames] ?? accountId;
}
