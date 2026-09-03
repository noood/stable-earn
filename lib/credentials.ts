import { env } from "cloudflare:workers";
import type { D1Database } from "@cloudflare/workers-types";

type StoredCredential = {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
};

export const credentialAccounts = [
  { id: "binance-global", label: "Binance.com", requiresPassphrase: false, syncDescription: "自动同步活期产品、APR 与持仓" },
  { id: "binance-bahrain", label: "Binance Bahrain", requiresPassphrase: false, syncDescription: "自动同步活期产品、APR 与持仓" },
  { id: "bybit-global", label: "Bybit.com", requiresPassphrase: false, syncDescription: "自动同步活期持仓，以及定期产品、APR 与持仓" },
  { id: "bitget-global", label: "Bitget", requiresPassphrase: true, syncDescription: "自动同步活期产品、APR 与持仓" },
  { id: "okx-global", label: "OKX", requiresPassphrase: true, syncDescription: "自动同步持仓" },
] as const;

export const manualDataAccounts = [
  { id: "mexc-ph", label: "MEXC · PH 🇵🇭", syncDescription: "产品信息与持仓需要手动维护" },
  { id: "mexc-uk", label: "MEXC · UK 🇬🇧", syncDescription: "产品信息与持仓需要手动维护" },
] as const;

export type CredentialAccountId = typeof credentialAccounts[number]["id"];

type CredentialRow = { account_id: string; ciphertext: string; iv: string };
type EncryptionEnv = Cloudflare.Env & { CREDENTIAL_ENCRYPTION_KEY?: string };

export function credentialAccount(accountId: string) {
  return credentialAccounts.find((account) => account.id === accountId) ?? null;
}

export async function listConfiguredCredentialIds(db: D1Database, userId: string) {
  const result = await db
    .prepare("SELECT account_id FROM exchange_credentials WHERE user_id = ? ORDER BY account_id")
    .bind(userId)
    .all<{ account_id: string }>();
  return result.results.map((row) => row.account_id);
}

export async function loadCredentials(db: D1Database, userId: string) {
  const result = await db
    .prepare("SELECT account_id, ciphertext, iv FROM exchange_credentials WHERE user_id = ?")
    .bind(userId)
    .all<CredentialRow>();
  const entries = await Promise.all(result.results.map(async (row) => [
    row.account_id,
    await decryptCredential(userId, row.account_id, row.ciphertext, row.iv),
  ] as const));
  return Object.fromEntries(entries) as Partial<Record<CredentialAccountId, StoredCredential>>;
}

export async function saveCredential(
  db: D1Database,
  userId: string,
  accountId: CredentialAccountId,
  credential: StoredCredential,
) {
  const encrypted = await encryptCredential(userId, accountId, credential);
  const updatedAt = new Date().toISOString();
  await db.prepare(`INSERT INTO exchange_credentials (user_id, account_id, ciphertext, iv, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, account_id)
      DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, updated_at = excluded.updated_at`)
    .bind(userId, accountId, encrypted.ciphertext, encrypted.iv, updatedAt)
    .run();
}

export async function deleteCredential(db: D1Database, userId: string, accountId: CredentialAccountId) {
  await db.prepare("DELETE FROM exchange_credentials WHERE user_id = ? AND account_id = ?")
    .bind(userId, accountId)
    .run();
}

async function encryptCredential(userId: string, accountId: string, credential: StoredCredential) {
  const key = await encryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(credential));
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv,
    additionalData: additionalData(userId, accountId),
  }, key, plaintext);
  return { ciphertext: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) };
}

async function decryptCredential(userId: string, accountId: string, ciphertext: string, iv: string) {
  const key = await encryptionKey();
  const plaintext = await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: base64ToBytes(iv),
    additionalData: additionalData(userId, accountId),
  }, key, base64ToBytes(ciphertext));
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<StoredCredential>;
  if (!parsed.apiKey || !parsed.apiSecret) throw new Error("Stored credential is invalid");
  return { apiKey: parsed.apiKey, apiSecret: parsed.apiSecret, passphrase: parsed.passphrase };
}

async function encryptionKey() {
  const raw = (env as EncryptionEnv).CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!raw) throw new Error("Credential encryption is not configured");
  const bytes = base64ToBytes(raw);
  if (bytes.byteLength !== 32) throw new Error("Credential encryption key must be 32 bytes");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function additionalData(userId: string, accountId: string) {
  return new TextEncoder().encode(`stable-earn:v1:${userId}:${accountId}`);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
