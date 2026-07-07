import type { Chat } from './api';
import {
  importPrivateKey,
  importPublicKey,
  importGroupKey,
  encryptWithGroupKey,
  encryptDirectMessage,
  decryptFromUser,
} from './crypto';
import {
  loadGroupKey,
  loadGroupKeyEpoch,
  saveGroupKeyWithEpoch,
} from './storage';

async function unwrapGroupKeyFromMember(
  chat: Chat,
  myUserId: string,
  privateKey: CryptoKey
): Promise<CryptoKey> {
  const me = chat.members.find((m) => m.id === myUserId);
  if (!me?.encryptedGroupKey) throw new Error('Нет ключа группы');

  const payload = JSON.parse(me.encryptedGroupKey) as {
    ciphertext: string;
    iv: string;
    encryptedBy?: string;
  };
  const encryptorId = payload.encryptedBy ?? chat.members[0]?.id;
  const encryptor = chat.members.find((m) => m.id === encryptorId) ?? chat.members[0];
  const encryptorPub = await importPublicKey(encryptor.publicKey);
  const raw = await decryptFromUser(payload.ciphertext, payload.iv, privateKey, encryptorPub);
  return importGroupKey(raw);
}

export async function getChatEncryptionKey(
  chat: Chat,
  myUserId: string,
  myPrivateKeyB64: string
): Promise<CryptoKey> {
  const privateKey = await importPrivateKey(myPrivateKeyB64);

  if (chat.type === 'group') {
    const serverEpoch = chat.groupKeyEpoch ?? 1;
    const cachedEpoch = await loadGroupKeyEpoch(chat.id);
    const cached = await loadGroupKey(chat.id);

    if (cached && cachedEpoch === serverEpoch) {
      return importGroupKey(cached);
    }

    const groupKey = await unwrapGroupKeyFromMember(chat, myUserId, privateKey);
    const exported = await crypto.subtle.exportKey('raw', groupKey);
    const keyB64 = btoa(String.fromCharCode(...new Uint8Array(exported)));
    await saveGroupKeyWithEpoch(chat.id, keyB64, serverEpoch);
    return groupKey;
  }

  const other = chat.members.find((m) => m.id !== myUserId)!;
  const theirPub = await importPublicKey(other.publicKey);
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: theirPub },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptChatMessage(
  plaintext: string,
  chat: Chat,
  userId: string,
  privateKeyB64: string
): Promise<{ ciphertext: string; iv: string }> {
  if (chat.type === 'group') {
    const key = await getChatEncryptionKey(chat, userId, privateKeyB64);
    return encryptWithGroupKey(plaintext, key);
  }

  const other = chat.members.find((m) => m.id !== userId)!;
  const theirPub = await importPublicKey(other.publicKey);
  return encryptDirectMessage(plaintext, theirPub);
}
