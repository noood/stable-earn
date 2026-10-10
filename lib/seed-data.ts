import type { Account } from "./domain";
import { accountDisplayNames } from "./platform-display";

export const accounts: Account[] = [
  { id: "binance-global", exchange: "binance", region: "global", name: accountDisplayNames["binance-global"], mark: "BN", color: "#f0b90b" },
  { id: "binance-bahrain", exchange: "binance", region: "bahrain", name: accountDisplayNames["binance-bahrain"], mark: "BH", color: "#f0b90b" },
  { id: "bybit-global", exchange: "bybit", region: "global", name: accountDisplayNames["bybit-global"], mark: "BY", color: "#f7a600" },
  { id: "bybit-eu", exchange: "bybit", region: "eu", name: accountDisplayNames["bybit-eu"], mark: "EU", color: "#f7a600" },
  { id: "bitget-global", exchange: "bitget", region: "global", name: accountDisplayNames["bitget-global"], mark: "BG", color: "#0bbfd0" },
  { id: "okx-global", exchange: "okx", region: "global", name: accountDisplayNames["okx-global"], mark: "OX", color: "#111111", foreground: "#ffffff" },
  { id: "mexc-ph", exchange: "mexc", region: "philippines", name: accountDisplayNames["mexc-ph"], mark: "PH", color: "#00a9df", foreground: "#ffffff" },
  { id: "mexc-uk", exchange: "mexc", region: "uk", name: accountDisplayNames["mexc-uk"], mark: "UK", color: "#00a9df", foreground: "#ffffff" },
];
