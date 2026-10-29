import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { prepareRefreshCommitGuard } from "./refresh-control";
import { normalizeWalletAddress } from "./wallet-address";

export { normalizeWalletAddress } from "./wallet-address";

const walletAccountId = "bitget-wallet-morph";

export async function loadWalletConfig(db: D1Database, userId: string) {
  const row = await db.prepare("SELECT address, updated_at FROM wallet_configs WHERE user_id = ?")
    .bind(userId).first<{ address: string; updated_at: string }>();
  if (!row) return null;
  const address = normalizeWalletAddress(row.address);
  if (!address) throw new Error("Stored wallet address is invalid");
  return { address, updatedAt: row.updated_at };
}

/** The caller owns the configuration lease; changing wallets must not reuse old balances. */
export async function saveWalletConfig(db: D1Database, userId: string, address: string, leaseToken: string) {
  const normalized = normalizeWalletAddress(address);
  if (!normalized) throw new Error("Invalid wallet address");
  const previous = await loadWalletConfig(db, userId);
  if (previous?.address === normalized) return previous;
  const updatedAt = new Date().toISOString();
  await db.batch([
    prepareRefreshCommitGuard(db, userId, leaseToken),
    ...resetWalletSnapshotStatements(db, userId, updatedAt, leaseToken),
    db.prepare(`INSERT INTO wallet_configs (user_id, address, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET address = excluded.address, updated_at = excluded.updated_at`)
      .bind(userId, normalized, updatedAt),
  ]);
  return { address: normalized, updatedAt };
}

export async function deleteWalletConfig(db: D1Database, userId: string, leaseToken: string) {
  const now = new Date().toISOString();
  await db.batch([
    prepareRefreshCommitGuard(db, userId, leaseToken),
    ...resetWalletSnapshotStatements(db, userId, now, leaseToken),
    db.prepare("DELETE FROM wallet_configs WHERE user_id = ?").bind(userId),
  ]);
}

function resetWalletSnapshotStatements(db: D1Database, userId: string, now: string, leaseToken: string): D1PreparedStatement[] {
  const walletProducts = `SELECT product_id FROM product_catalog
    WHERE owner_id = ? AND json_valid(payload) AND json_extract(payload, '$.accountId') = ?`;
  return [
    db.prepare(`DELETE FROM holdings WHERE user_id = ? AND product_id IN (${walletProducts})`)
      .bind(userId, userId, walletAccountId),
    db.prepare(`DELETE FROM holding_positions WHERE user_id = ? AND product_id IN (${walletProducts})`)
      .bind(userId, userId, walletAccountId),
    db.prepare(`UPDATE product_catalog SET status = 'archived', archived_at = ?, last_seen_at = ?
      WHERE owner_id = ? AND json_valid(payload) AND json_extract(payload, '$.accountId') = ?`)
      .bind(now, now, userId, walletAccountId),
    db.prepare("DELETE FROM sync_snapshots WHERE owner_id = ? AND cache_key = 'private-products'").bind(userId),
    db.prepare("UPDATE refresh_control SET daily_day = NULL WHERE user_id = ? AND lease_token = ?")
      .bind(userId, leaseToken),
  ];
}
