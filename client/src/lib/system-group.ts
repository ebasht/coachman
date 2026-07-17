import { api, type Chat } from './api';
import {
  generateGroupKey,
  exportGroupKey,
  importPublicKey,
  wrapGroupKeyForMember,
  importPrivateKey,
  decryptFromUser,
} from './crypto';
import { loadGroupKey, loadGroupKeyEpoch, saveGroupKeyWithEpoch, archiveGroupKey } from './storage';

type ResolveResult = {
  keyRaw: string;
  /** True when key came from decrypting the server wrap (trusted for redistribute). */
  fromUnwrap: boolean;
  /** True when my server wrap decrypts to keyRaw. */
  myWrapOk: boolean;
};

async function tryUnwrapMyWrap(
  chat: Chat,
  userId: string,
  privateKey: CryptoKey,
): Promise<string | null> {
  const me = chat.members.find((m) => m.id === userId);
  if (!me?.encryptedGroupKey) return null;

  const payload = JSON.parse(me.encryptedGroupKey) as {
    ciphertext: string;
    iv: string;
    encryptedBy?: string;
  };
  const candidates: typeof chat.members = [];
  if (payload.encryptedBy) {
    const enc = chat.members.find((m) => m.id === payload.encryptedBy);
    if (enc) candidates.push(enc);
  }
  for (const m of chat.members) {
    if (!candidates.some((c) => c.id === m.id)) candidates.push(m);
  }
  for (const encryptor of candidates) {
    try {
      const encryptorPub = await importPublicKey(encryptor.publicKey);
      return await decryptFromUser(payload.ciphertext, payload.iv, privateKey, encryptorPub);
    } catch {
      /* next */
    }
  }
  return null;
}

async function resolveSystemGroupKey(
  chat: Chat,
  userId: string,
  privateKey: CryptoKey,
): Promise<ResolveResult | null> {
  const serverEpoch = chat.groupKeyEpoch ?? 1;
  const unwrapped = await tryUnwrapMyWrap(chat, userId, privateKey);

  if (unwrapped) {
    const cached = await loadGroupKey(userId, chat.id);
    if (cached && cached !== unwrapped) {
      await archiveGroupKey(userId, chat.id, serverEpoch, cached);
    }
    await saveGroupKeyWithEpoch(userId, chat.id, unwrapped, serverEpoch);
    return { keyRaw: unwrapped, fromUnwrap: true, myWrapOk: true };
  }

  const cachedEpoch = await loadGroupKeyEpoch(userId, chat.id);
  const cached = await loadGroupKey(userId, chat.id);
  if (cached && (cachedEpoch === serverEpoch || cachedEpoch == null)) {
    return {
      keyRaw: cached,
      fromUnwrap: false,
      myWrapOk: false,
    };
  }

  const anyoneHasKey = chat.members.some((m) => !!m.encryptedGroupKey);
  if (anyoneHasKey) {
    return null;
  }

  const groupKey = await generateGroupKey();
  const raw = await exportGroupKey(groupKey);
  await saveGroupKeyWithEpoch(userId, chat.id, raw, serverEpoch);
  return { keyRaw: raw, fromUnwrap: true, myWrapOk: false };
}

function healToken(chatId: string, keyRaw: string): string {
  return `sysheal:${chatId}:${keyRaw.slice(0, 24)}`;
}

/** Initialize or repair the system group AES key wraps. */
export async function syncSystemGroupKeys(
  chats: Chat[],
  userId: string,
  privateKeyB64: string,
): Promise<boolean> {
  const chat = chats.find((c) => c.isSystem && c.type === 'group');
  if (!chat) return false;

  const privateKey = await importPrivateKey(privateKeyB64);
  let resolved: ResolveResult | null;
  try {
    resolved = await resolveSystemGroupKey(chat, userId, privateKey);
  } catch {
    return false;
  }
  if (!resolved) return false;

  const { keyRaw, fromUnwrap, myWrapOk } = resolved;
  // Only redistribute a key we proved via unwrap (or freshly generated when no wraps exist).
  if (!fromUnwrap) return false;

  const missing = chat.members.filter((m) => !m.encryptedGroupKey);
  const token = healToken(chat.id, keyRaw);
  let alreadyHealed = false;
  try {
    alreadyHealed = sessionStorage.getItem(token) === '1';
  } catch {
    /* private mode */
  }

  // Missing wraps, broken own wrap, or one full heal per session (repairs peers with stale wraps).
  if (missing.length === 0 && myWrapOk && alreadyHealed) {
    return false;
  }

  const wraps: { userId: string; encryptedGroupKey: string }[] = [];
  for (const member of chat.members) {
    try {
      const pub = await importPublicKey(member.publicKey);
      wraps.push({
        userId: member.id,
        encryptedGroupKey: await wrapGroupKeyForMember(keyRaw, privateKey, pub, userId),
      });
    } catch {
      /* skip */
    }
  }
  if (wraps.length === 0) return false;

  await api.distributeSystemGroupKeys(chat.id, wraps);
  try {
    sessionStorage.setItem(token, '1');
  } catch {
    /* ignore */
  }
  return true;
}
