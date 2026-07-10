import { api, type Chat } from './api';
import {
  generateGroupKey,
  exportGroupKey,
  importPublicKey,
  wrapGroupKeyForMember,
  importPrivateKey,
  decryptFromUser,
} from './crypto';
import { loadGroupKey, loadGroupKeyEpoch, saveGroupKeyWithEpoch } from './storage';

async function resolveSystemGroupKeyRaw(
  chat: Chat,
  userId: string,
  privateKey: CryptoKey
): Promise<string | null> {
  const serverEpoch = chat.groupKeyEpoch ?? 1;
  const cachedEpoch = await loadGroupKeyEpoch(chat.id);
  const cached = await loadGroupKey(chat.id);
  if (cached && cachedEpoch === serverEpoch) {
    return cached;
  }

  const me = chat.members.find((m) => m.id === userId);
  if (me?.encryptedGroupKey) {
    const payload = JSON.parse(me.encryptedGroupKey) as {
      ciphertext: string;
      iv: string;
      encryptedBy?: string;
    };
    const encryptorId = payload.encryptedBy ?? chat.members[0]?.id;
    const encryptor = chat.members.find((m) => m.id === encryptorId) ?? chat.members[0];
    if (!encryptor) return null;
    const encryptorPub = await importPublicKey(encryptor.publicKey);
    const raw = await decryptFromUser(payload.ciphertext, payload.iv, privateKey, encryptorPub);
    await saveGroupKeyWithEpoch(chat.id, raw, serverEpoch);
    return raw;
  }

  const anyoneHasKey = chat.members.some((m) => !!m.encryptedGroupKey);
  if (anyoneHasKey) {
    // Waiting for another member to wrap the key for us.
    return null;
  }

  const groupKey = await generateGroupKey();
  const raw = await exportGroupKey(groupKey);
  await saveGroupKeyWithEpoch(chat.id, raw, serverEpoch);
  return raw;
}

/** Initialize or distribute the system group AES key to members who lack a wrap. */
export async function syncSystemGroupKeys(
  chats: Chat[],
  userId: string,
  privateKeyB64: string
): Promise<boolean> {
  const chat = chats.find((c) => c.isSystem && c.type === 'group');
  if (!chat) return false;

  const privateKey = await importPrivateKey(privateKeyB64);
  let keyRaw: string | null;
  try {
    keyRaw = await resolveSystemGroupKeyRaw(chat, userId, privateKey);
  } catch {
    return false;
  }
  if (!keyRaw) return false;

  const missing = chat.members.filter((m) => !m.encryptedGroupKey);
  if (missing.length === 0) return false;

  const wraps: { userId: string; encryptedGroupKey: string }[] = [];
  for (const member of missing) {
    try {
      const pub = await importPublicKey(member.publicKey);
      wraps.push({
        userId: member.id,
        encryptedGroupKey: await wrapGroupKeyForMember(keyRaw, privateKey, pub, userId),
      });
    } catch {
      // skip member with bad key material
    }
  }
  if (wraps.length === 0) return false;

  await api.distributeSystemGroupKeys(chat.id, wraps);
  return true;
}
