import type { Chat } from './api';
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
} from './storage';

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
async function unwrapGroupKeyFromMember(
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

export async function getChatEncryptionKey(
  chat: Chat,
  myUserId: string,
  myPrivateKeyB64: string,
  opts?: { forceRefresh?: boolean },
): Promise<CryptoKey> {
  const privateKey = await importPrivateKey(myPrivateKeyB64);

  if (chat.type === 'group') {
    const serverEpoch = chat.groupKeyEpoch ?? 1;
    if (!opts?.forceRefresh) {
      const cachedEpoch = await loadGroupKeyEpoch(chat.id);
      const cached = await loadGroupKey(chat.id);
      if (cached && cachedEpoch === serverEpoch) {
        return importGroupKey(cached);
      }
    }

    const { key, rawB64 } = await unwrapGroupKeyFromMember(chat, myUserId, privateKey);
    await saveGroupKeyWithEpoch(chat.id, rawB64, serverEpoch);
    return key;
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

export async function encryptChatMessage(
  plaintext: string,
  chat: Chat,
  userId: string,
  privateKeyB64: string,
): Promise<{ ciphertext: string; iv: string }> {
  if (chat.type === 'group') {
    const key = await getChatEncryptionKey(chat, userId, privateKeyB64);
    return encryptWithGroupKey(plaintext, key);
  }

  const other = chat.members.find((m) => m.id !== userId);
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
    const tryWithKey = async (key: CryptoKey) => decryptWithGroupKey(ciphertext, iv, key);

    try {
      return await tryWithKey(await getChatEncryptionKey(chat, myUserId, myPrivateKeyB64));
    } catch {
      /* continue */
    }

    try {
      return await tryWithKey(
        await getChatEncryptionKey(chat, myUserId, myPrivateKeyB64, { forceRefresh: true }),
      );
    } catch {
      /* continue */
    }

    const archive = await loadGroupKeyArchive(chat.id);
    const epochs = Object.keys(archive)
      .map(Number)
      .sort((a, b) => b - a);
    for (const epoch of epochs) {
      try {
        return await tryWithKey(await importGroupKey(archive[epoch]));
      } catch {
        /* try older */
      }
    }
    throw new Error('cannot decrypt group message');
  }

  const privateKey = await importPrivateKey(myPrivateKeyB64);
  const other = chat.members.find((m) => m.id !== myUserId);
  if (!other?.publicKey) throw new Error('Нет собеседника в чате');
  const theirPub = await importPublicKey(other.publicKey);
  return decryptDirectMessage(ciphertext, iv, privateKey, theirPub);
}
