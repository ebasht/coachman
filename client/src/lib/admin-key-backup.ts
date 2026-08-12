import { encryptSecret, decryptSecret } from './key-storage';
import {
  exportGroupKeyMaterial,
  importGroupKeyMaterial,
  saveKey,
  getKey,
  deleteKey,
  type LocalAccount,
  type GroupKeyBackupEntry,
} from './storage';
import { api } from './api';

const BACKUP_VERSION = 1;
const BOOTSTRAP_TOKEN_KEY = 'bootstrapRecoveryToken';

export type AdminKeyBackupPayload = {
  v: number;
  userId: string;
  username: string;
  publicKey: string;
  privateKey: string;
  signingPublicKey?: string;
  signingPrivateKey?: string;
  groupKeys?: Record<string, GroupKeyBackupEntry>;
};

export async function rememberBootstrapToken(token: string) {
  if (!token) return;
  await saveKey(BOOTSTRAP_TOKEN_KEY, token);
}

export async function loadRememberedBootstrapToken(): Promise<string | undefined> {
  const token = await getKey(BOOTSTRAP_TOKEN_KEY);
  return token || undefined;
}

export async function clearRememberedBootstrapToken() {
  await deleteKey(BOOTSTRAP_TOKEN_KEY);
}

async function buildPayload(account: LocalAccount): Promise<AdminKeyBackupPayload | null> {
  if (!account.privateKey) return null;
  return {
    v: BACKUP_VERSION,
    userId: account.userId,
    username: account.username,
    publicKey: account.publicKey,
    privateKey: account.privateKey,
    signingPublicKey: account.signingPublicKey,
    signingPrivateKey: account.signingPrivateKey,
    groupKeys: await exportGroupKeyMaterial(account.userId),
  };
}

/** Encrypt admin identity (+ group keys) with the bootstrap token and upload. */
export async function uploadAdminKeyBackup(
  account: LocalAccount,
  bootstrapToken: string,
): Promise<boolean> {
  if (!bootstrapToken || !account.isAdmin) return false;
  const payload = await buildPayload(account);
  if (!payload) return false;
  const encrypted = await encryptSecret(JSON.stringify(payload), bootstrapToken);
  await api.putAdminKeyBackup({
    bootstrapToken,
    userId: account.userId,
    salt: encrypted.salt,
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext,
    version: BACKUP_VERSION,
  });
  await rememberBootstrapToken(bootstrapToken);
  return true;
}

export async function tryUploadAdminKeyBackup(account: LocalAccount): Promise<void> {
  const token = await loadRememberedBootstrapToken();
  if (!token) return;
  try {
    await uploadAdminKeyBackup(account, token);
  } catch {
    /* best-effort — restore still works with last good backup */
  }
}

/**
 * Fetch + decrypt admin key backup using the bootstrap token.
 * Returns a LocalAccount ready to authenticate (private keys unwrapped).
 */
export async function restoreAdminFromBackup(
  bootstrapToken: string,
): Promise<LocalAccount | null> {
  let blob: {
    userId: string;
    salt: string;
    iv: string;
    ciphertext: string;
    version: number;
  };
  try {
    blob = await api.fetchAdminKeyBackup(bootstrapToken);
  } catch {
    return null;
  }
  let raw: string;
  try {
    raw = await decryptSecret(
      { salt: blob.salt, iv: blob.iv, ciphertext: blob.ciphertext },
      bootstrapToken,
    );
  } catch {
    return null;
  }
  let payload: AdminKeyBackupPayload;
  try {
    payload = JSON.parse(raw) as AdminKeyBackupPayload;
  } catch {
    return null;
  }
  if (!payload?.userId || !payload.privateKey || !payload.publicKey) return null;

  if (payload.groupKeys) {
    try {
      await importGroupKeyMaterial(payload.userId, payload.groupKeys);
    } catch {
      /* identity restore still valuable */
    }
  }

  await rememberBootstrapToken(bootstrapToken);

  return {
    userId: payload.userId,
    username: payload.username,
    publicKey: payload.publicKey,
    privateKey: payload.privateKey,
    signingPublicKey: payload.signingPublicKey,
    signingPrivateKey: payload.signingPrivateKey,
    isAdmin: true,
  };
}

/** Re-import group AES keys from the server backup (e.g. after logout cleared local cache). */
export async function hydrateGroupKeysFromBackup(
  bootstrapToken: string,
  userId: string,
): Promise<boolean> {
  try {
    const blob = await api.fetchAdminKeyBackup(bootstrapToken);
    const raw = await decryptSecret(
      { salt: blob.salt, iv: blob.iv, ciphertext: blob.ciphertext },
      bootstrapToken,
    );
    const payload = JSON.parse(raw) as AdminKeyBackupPayload;
    if (!payload.groupKeys || payload.userId !== userId) return false;
    await importGroupKeyMaterial(userId, payload.groupKeys);
    return true;
  } catch {
    return false;
  }
}
