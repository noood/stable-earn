import type { Account } from "./domain";
import { accountDisplayNames } from "./platform-display";

export const accounts: Account[] = [
  { id: "binance-global", exchange: "binance", region: "global", name: accountDisplayNames["binance-global"], logo: "/platforms/binance.webp" },
  { id: "binance-bahrain", exchange: "binance", region: "bahrain", name: accountDisplayNames["binance-bahrain"], logo: "/platforms/binance.webp" },
  { id: "bybit-global", exchange: "bybit", region: "global", name: accountDisplayNames["bybit-global"], logo: "/platforms/bybit.webp" },
  { id: "bybit-eu", exchange: "bybit", region: "eu", name: accountDisplayNames["bybit-eu"], logo: "/platforms/bybit-eu.webp" },
  { id: "bitget-global", exchange: "bitget", region: "global", name: accountDisplayNames["bitget-global"], logo: "/platforms/bitget.webp" },
  { id: "bitget-wallet-morph", exchange: "bitget-wallet", region: "morph", name: accountDisplayNames["bitget-wallet-morph"], logo: "/platforms/bitget-wallet.webp" },
  { id: "okx-global", exchange: "okx", region: "global", name: accountDisplayNames["okx-global"], logo: "/platforms/okx.webp" },
  { id: "mexc-ph", exchange: "mexc", region: "philippines", name: accountDisplayNames["mexc-ph"], logo: "/platforms/mexc.webp" },
  { id: "mexc-uk", exchange: "mexc", region: "uk", name: accountDisplayNames["mexc-uk"], logo: "/platforms/mexc.webp" },
];
