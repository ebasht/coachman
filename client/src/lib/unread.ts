import { api, type Chat } from './api';
import { getKey, saveKey, getMessages } from './storage';

function readKey(userId: string, chatId: string) {
  return `readAt:${userId}:${chatId}`;
}

export async function getLastReadAt(userId: string, chatId: string): Promise<number> {
  const raw = await getKey(readKey(userId, chatId));
  return raw ? Number(raw) : 0;
}

export async function setLastReadAt(userId: string, chatId: string, at: number) {
  await saveKey(readKey(userId, chatId), String(at));
}

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

  try {
    const raw = await api.getMessages(chat.id, lastRead);
    return raw.filter((m) => m.senderId !== userId).length;
  } catch {
    return Math.max(localCount, 1);
  }
}

export async function computeUnreadCounts(chats: Chat[], userId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  await Promise.all(
    chats.map(async (chat) => {
      counts[chat.id] = await countUnreadForChat(chat, userId);
    }),
  );
  return counts;
}
