import type { Chat } from './api';
import { api } from './api';
import {
  importPrivateKey,
  importPublicKey,
  importGroupKey,
  encryptWithGroupKey,
  encryptDirectMessage,
  encryptWithKey,
  encryptForUser,
  decryptFromUser,
  decryptWithGroupKey,
  decryptDirectMessage,
} from './crypto';
import {
  loadGroupKey,
  loadGroupKeyEpoch,
  saveGroupKeyWithEpoch,
  loadGroupKeyArchive,
  getLocalAccountByUserId,
} from './storage';
import { syncSystemGroupKeys } from './system-group';
import {
  hydrateGroupKeysFromBackup,
  loadRememberedBootstrapToken,
  tryUploadAdminKeyBackup,
} from './admin-key-backup';
import { repairGroupWrapsIfNeeded } from './group-wrap-repair';

/** Brief plaintext experiment marker — still readable if any such rows exist. */
export const PLAIN_IV = 'plain';

export function isPlainIv(iv: string | null | undefined): boolean {
  return iv === 'plain' || iv === 'plain-v1';
}

/**
 * Unwrap the AES group key from my member wrap.
 * Tries encryptedBy first, then every member — wraps were historically encrypted by
 * whoever ran syncSystemGroupKeys, not always members[0].
 */
export async function unwrapGroupKeyFromMember(
  chat: Chat,
  myUserId: string,
  privateKey: CryptoKey,
): Promise<{ key: CryptoKey; rawB64: string }> {
  const me = chat.members.find((m) => m.id === myUserId);
  if (!me?.encryptedGroupKey) throw new Error('Нет ключа группы');

  const payload = JSON.parse(me.encryptedGroupKey) as {
    ciphertext: string;
    iv: string;
    encryptedBy?: string;
  };

  const candidates: Chat['members'] = [];
  if (payload.encryptedBy) {
    const enc = chat.members.find((m) => m.id === payload.encryptedBy);
    if (enc) candidates.push(enc);
  }
  for (const m of chat.members) {
    if (!candidates.some((c) => c.id === m.id)) candidates.push(m);
  }

  let lastErr: unknown;
  for (const encryptor of candidates) {
    try {
      const encryptorPub = await importPublicKey(encryptor.publicKey);
      const raw = await decryptFromUser(
        payload.ciphertext,
        payload.iv,
        privateKey,
        encryptorPub,
      );
      return { key: await importGroupKey(raw), rawB64: raw };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Не удалось развернуть ключ группы');
}

/**
 * Group AES key for encrypt/decrypt.
 * Server wrap is authoritative when it unwraps. If the wrap is missing (e.g. after
 * bootstrap rebind cleared admin wraps), fall back to local/backup cache so sending
 * and history still work, then syncSystemGroupKeys can republish wraps.
 */
export async function getChatEncryptionKey(
  chat: Chat,
  myUserId: string,
  myPrivateKeyB64: string,
  opts?: { forceRefresh?: boolean },
): Promise<CryptoKey> {
  const privateKey = await importPrivateKey(myPrivateKeyB64);

  if (chat.type === 'group') {
    const serverEpoch = chat.groupKeyEpoch ?? 1;
    const me = chat.members.find((m) => m.id === myUserId);
    const wrapMissing = !me?.encryptedGroupKey;

    if (me?.encryptedGroupKey) {
      try {
        const { key, rawB64 } = await unwrapGroupKeyFromMember(chat, myUserId, privateKey);
        const cached = await loadGroupKey(myUserId, chat.id);
        if (!cached || cached !== rawB64 || opts?.forceRefresh) {
          await saveGroupKeyWithEpoch(myUserId, chat.id, rawB64, serverEpoch);
        }
        return key;
      } catch {
        // Fall through to cache / archive — wrap may be stale until sync repairs it.
      }
    }

    const cachedEpoch = await loadGroupKeyEpoch(myUserId, chat.id);
    const cached = await loadGroupKey(myUserId, chat.id);
    if (cached) {
      const epochOk = cachedEpoch === serverEpoch || cachedEpoch == null;
      // Missing wrap (rebind) → trust local/backup key even when forceRefresh.
      if (wrapMissing || (!opts?.forceRefresh && epochOk)) {
        if (wrapMissing || cachedEpoch == null) {
          await saveGroupKeyWithEpoch(myUserId, chat.id, cached, serverEpoch);
        }
        return importGroupKey(cached);
      }
    }

    // Last resort: any archived key for this chat (still better than failing send).
    if (wrapMissing) {
      const archive = await loadGroupKeyArchive(myUserId, chat.id);
      const archived = Object.values(archive).filter(Boolean);
      if (archived.length) {
        const raw = archived[archived.length - 1]!;
        await saveGroupKeyWithEpoch(myUserId, chat.id, raw, serverEpoch);
        return importGroupKey(raw);
      }
    }

    if (me?.encryptedGroupKey) {
      const { key, rawB64 } = await unwrapGroupKeyFromMember(chat, myUserId, privateKey);
      await saveGroupKeyWithEpoch(myUserId, chat.id, rawB64, serverEpoch);
      return key;
    }

    throw new Error('Нет ключа группы');
  }

  const other = chat.members.find((m) => m.id !== myUserId);
  if (!other?.publicKey) {
    throw new Error('Нет собеседника в чате');
  }
  const theirPub = await importPublicKey(other.publicKey);
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: theirPub },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** All known group key material for this chat (current + archive). */
async function collectGroupKeyCandidates(
  chat: Chat,
  myUserId: string,
  myPrivateKeyB64: string,
): Promise<CryptoKey[]> {
  const keys: CryptoKey[] = [];
  const seen = new Set<string>();
  const addRaw = async (raw: string | undefined) => {
    if (!raw || seen.has(raw)) return;
    seen.add(raw);
    keys.push(await importGroupKey(raw));
  };

  try {
    const unwrapped = await unwrapGroupKeyFromMember(
      chat,
      myUserId,
      await importPrivateKey(myPrivateKeyB64),
    );
    await addRaw(unwrapped.rawB64);
  } catch {
    /* no wrap */
  }

  await addRaw(await loadGroupKey(myUserId, chat.id));

  const archive = await loadGroupKeyArchive(myUserId, chat.id);
  for (const raw of Object.values(archive)) {
    await addRaw(raw);
  }

  return keys;
}

/**
 * Refresh chat membership/wraps and recover group key material before encrypt.
 * Fixes send failures after bootstrap when admin wraps were cleared.
 */
export async function prepareChatEncryption(
  chat: Chat,
  userId: string,
  privateKeyB64: string,
): Promise<Chat> {
  if (chat.type !== 'group') return chat;

  let current = chat;
  try {
    const token = await loadRememberedBootstrapToken();
    if (token) await hydrateGroupKeysFromBackup(token, userId);
  } catch {
    /* optional */
  }

  try {
    const freshList = await api.getChats();
    const fresh = freshList.find((c) => c.id === chat.id);
    if (fresh) current = fresh;
  } catch {
    /* use provided chat */
  }

  try {
    if (current.isSystem) {
      const repaired = await syncSystemGroupKeys([current], userId, privateKeyB64);
      if (repaired) {
        const again = (await api.getChats()).find((c) => c.id === chat.id);
        if (again) current = again;
      }
    }
    current = await repairGroupWrapsIfNeeded(current, userId, privateKeyB64);
  } catch {
    /* getChatEncryptionKey below will surface the error */
  }

  // Refresh encrypted backup after we (re)learned group keys.
  try {
    const account = await getLocalAccountByUserId(userId);
    if (account?.privateKey && account.isAdmin) {
      void tryUploadAdminKeyBackup({ ...account, isAdmin: true });
    }
  } catch {
    /* best-effort */
  }

  return current;
}

export async function encryptChatMessage(
  plaintext: string,
  chat: Chat,
  userId: string,
  privateKeyB64: string,
): Promise<{ ciphertext: string; iv: string }> {
  const ready = await prepareChatEncryption(chat, userId, privateKeyB64);
  if (ready.type === 'group') {
    const key = await getChatEncryptionKey(ready, userId, privateKeyB64);
    return encryptWithGroupKey(plaintext, key);
  }

  const other = ready.members.find((m) => m.id !== userId);
  if (!other?.publicKey) throw new Error('Нет собеседника в чате');
  const theirPub = await importPublicKey(other.publicKey);
  return encryptDirectMessage(plaintext, theirPub);
}

/** Shared-secret encryption for chat-scoped data both members can decrypt (lists, etc.). */
export async function encryptChatShared(
  plaintext: string,
  chat: Chat,
  userId: string,
  privateKeyB64: string,
): Promise<{ ciphertext: string; iv: string }> {
  if (chat.type === 'group') {
    const key = await getChatEncryptionKey(chat, userId, privateKeyB64);
    return encryptWithKey(plaintext, key);
  }
  const privateKey = await importPrivateKey(privateKeyB64);
  const other = chat.members.find((m) => m.id !== userId);
  if (!other?.publicKey) throw new Error('Нет собеседника в чате');
  const theirPub = await importPublicKey(other.publicKey);
  return encryptForUser(plaintext, privateKey, theirPub);
}

export async function decryptChatShared(
  ciphertext: string,
  iv: string,
  chat: Chat,
  userId: string,
  privateKeyB64: string,
): Promise<string> {
  if (isPlainIv(iv)) return ciphertext;
  return decryptLegacyChatMessage(ciphertext, iv, chat, userId, privateKeyB64);
}

/** Decrypt ciphertext (or pass through brief plaintext experiment rows). */
export async function decryptLegacyChatMessage(
  ciphertext: string,
  iv: string,
  chat: Chat,
  myUserId: string,
  myPrivateKeyB64: string,
): Promise<string> {
  if (isPlainIv(iv)) return ciphertext;

  if (chat.type === 'group') {
    const candidates = await collectGroupKeyCandidates(chat, myUserId, myPrivateKeyB64);
    let lastErr: unknown;
    for (const key of candidates) {
      try {
        return await decryptWithGroupKey(ciphertext, iv, key);
      } catch (err) {
        lastErr = err;
      }
    }
    // One more force path in case wrap arrived mid-loop.
    try {
      return await decryptWithGroupKey(
        ciphertext,
        iv,
        await getChatEncryptionKey(chat, myUserId, myPrivateKeyB64, { forceRefresh: true }),
      );
    } catch (err) {
      lastErr = err;
    }
    throw lastErr instanceof Error ? lastErr : new Error('cannot decrypt group message');
  }

  const privateKey = await importPrivateKey(myPrivateKeyB64);
  const other = chat.members.find((m) => m.id !== myUserId);
  if (!other?.publicKey) throw new Error('Нет собеседника в чате');
  const theirPub = await importPublicKey(other.publicKey);
  return decryptDirectMessage(ciphertext, iv, privateKey, theirPub);
}
