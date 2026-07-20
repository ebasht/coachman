import { api, type Chat } from './api';
import { isOnline } from './network';
import { getKey, saveKey, getMessages } from './storage';

function readKey(userId: string, chatId: string) {
  return `readAt:${userId}:${chatId}`;
}

export async function getLastReadAt(userId: string, chatId: string): Promise<number> {
  const raw = await getKey(readKey(userId, chatId));
  return raw ? Number(raw) : 0;
}

export async function setLastReadAt(userId: string, chatId: string, at: number) {
  const prev = await getLastReadAt(userId, chatId);
  const next = Math.max(prev, at);
  if (next <= prev) return prev;
  await saveKey(readKey(userId, chatId), String(next));
  if (isOnline()) {
    void api.markChatRead(chatId, next).catch(() => {});
  }
  return next;
}

/** Local-only unread estimate — never hits the network (cold start must stay cheap). */
export async function countUnreadForChat(chat: Chat, userId: string): Promise<number> {
  const lastRead = await getLastReadAt(userId, chat.id);
  const local = await getMessages(chat.id);
  const localCount = local.filter(
    (m) => !m.pending && m.senderId !== userId && m.createdAt > lastRead,
  ).length;

  if (!chat.lastMessage || chat.lastMessage.senderId === userId || chat.lastMessage.createdAt <= lastRead) {
    return localCount;
  }

  if (local.some((m) => m.id === chat.lastMessage!.id)) {
    return localCount;
  }

  // Server has a newer message we have not cached yet — show a badge without
  // downloading every chat's history on app open.
  return Math.max(localCount, 1);
}

export async function computeUnreadCounts(chats: Chat[], userId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  // Bound concurrency so IndexedDB is not saturated on devices with many chats.
  const concurrency = 6;
  for (let i = 0; i < chats.length; i += concurrency) {
    const chunk = chats.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (chat) => {
        counts[chat.id] = await countUnreadForChat(chat, userId);
      }),
    );
  }
  return counts;
}
