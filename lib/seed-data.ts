import type { Account } from "./domain";

export const accounts: Account[] = [
  { id: "binance-global", exchange: "binance", region: "global", name: "Binance.com", mark: "BN", color: "#f0b90b" },
  { id: "binance-bahrain", exchange: "binance", region: "bahrain", name: "Binance Bahrain", mark: "BH", color: "#f0b90b" },
  { id: "bybit-global", exchange: "bybit", region: "global", name: "Bybit.com", mark: "BY", color: "#f7a600" },
  { id: "bybit-eu", exchange: "bybit", region: "eu", name: "Bybit EU", mark: "EU", color: "#f7a600" },
  { id: "bitget-global", exchange: "bitget", region: "global", name: "Bitget", mark: "BG", color: "#0bbfd0" },
  { id: "okx-global", exchange: "okx", region: "global", name: "OKX", mark: "OX", color: "#111111", foreground: "#ffffff" },
  { id: "mexc-ph", exchange: "mexc", region: "philippines", name: "MEXC · PH 🇵🇭", mark: "PH", color: "#00a9df", foreground: "#ffffff" },
  { id: "mexc-uk", exchange: "mexc", region: "uk", name: "MEXC · UK 🇬🇧", mark: "UK", color: "#00a9df", foreground: "#ffffff" },
];
