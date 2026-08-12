import { api, type Chat } from './api';
import { importPrivateKey, importPublicKey, wrapGroupKeyForMember } from './crypto';
import { loadGroupKey, loadGroupKeyEpoch, saveGroupKeyWithEpoch } from './storage';

/**
 * If our server wrap is missing but we still have the group AES key locally
 * (or restored from bootstrap backup), republish wraps so encrypt/send works again.
 */
export async function repairGroupWrapsIfNeeded(
  chat: Chat,
  userId: string,
  privateKeyB64: string,
): Promise<Chat> {
  if (chat.type !== 'group') return chat;
  const me = chat.members.find((m) => m.id === userId);
  if (me?.encryptedGroupKey) return chat;

  const keyRaw = await loadGroupKey(userId, chat.id);
  if (!keyRaw) return chat;

  const privateKey = await importPrivateKey(privateKeyB64);
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
  if (!wraps.length) return chat;

  const epoch = chat.groupKeyEpoch ?? (await loadGroupKeyEpoch(userId, chat.id)) ?? 1;
  await saveGroupKeyWithEpoch(userId, chat.id, keyRaw, epoch);

  if (chat.isSystem) {
    await api.distributeSystemGroupKeys(chat.id, wraps);
  } else {
    await api.distributeGroupKeyWraps(chat.id, wraps);
  }

  try {
    const fresh = (await api.getChats()).find((c) => c.id === chat.id);
    return fresh ?? chat;
  } catch {
    return chat;
  }
}
