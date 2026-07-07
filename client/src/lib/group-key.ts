import type { Chat } from './api';
import {
  generateGroupKey,
  exportGroupKey,
  importPublicKey,
  wrapGroupKeyForMember,
} from './crypto';

export interface GroupKeyWrap {
  userId: string;
  encryptedGroupKey: string;
}

export async function buildGroupKeyRotation(
  chat: Chat,
  memberIds: string[],
  currentUserId: string,
  privateKey: CryptoKey
): Promise<{ keyRaw: string; wraps: GroupKeyWrap[]; nextEpoch: number }> {
  const groupKey = await generateGroupKey();
  const keyRaw = await exportGroupKey(groupKey);
  const nextEpoch = (chat.groupKeyEpoch ?? 1) + 1;
  const wraps: GroupKeyWrap[] = [];

  for (const id of memberIds) {
    const member = chat.members.find((m) => m.id === id);
    if (!member) continue;
    const pub = await importPublicKey(member.publicKey);
    wraps.push({
      userId: id,
      encryptedGroupKey: await wrapGroupKeyForMember(keyRaw, privateKey, pub, currentUserId),
    });
  }

  return { keyRaw, wraps, nextEpoch };
}
