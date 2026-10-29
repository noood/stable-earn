/** A public EVM address; never accepts private keys, seed phrases or a zero address. */
export function normalizeWalletAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = value.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(address) && !/^0x0{40}$/.test(address)
    ? address.toLowerCase()
    : null;
}
