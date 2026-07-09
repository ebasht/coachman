import type { Chat } from './api';
import { getChats, getMessages, saveChat, type StoredChat } from './storage';

export async function saveChatFromApi(chat: Chat) {
  await saveChat({
    id: chat.id,
    type: chat.type,
    displayName: chat.displayName,
    members: chat.members,
    lastMessageAt: chat.lastMessage?.createdAt,
    lastMessage: chat.lastMessage ?? undefined,
    createdAt: chat.createdAt,
  });
}

function toChat(
  stored: StoredChat,
  lastMessage?: { id: string; senderId: string; type: string; createdAt: number },
): Chat {
  const resolved = stored.lastMessage ?? lastMessage ?? null;
  return {
    id: stored.id,
    type: stored.type,
    name: stored.type === 'group' ? stored.displayName : null,
    displayName: stored.displayName,
    members: stored.members,
    lastMessage: resolved,
    createdAt: stored.createdAt ?? stored.lastMessageAt ?? resolved?.createdAt ?? 0,
  };
}

export async function chatsFromLocalStore(): Promise<Chat[]> {
  const stored = await getChats();
  const chats = await Promise.all(
    stored.map(async (chat) => {
      if (chat.lastMessage) {
        return toChat(chat);
      }
      const messages = await getMessages(chat.id);
      const latest = messages
        .filter((m) => !m.pending)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      const lastMessage = latest
        ? { id: latest.id, senderId: latest.senderId, type: latest.type, createdAt: latest.createdAt }
        : undefined;
      return toChat(chat, lastMessage);
    }),
  );

  return chats.sort((a, b) => {
    const timeA = a.lastMessage?.createdAt ?? a.createdAt ?? 0;
    const timeB = b.lastMessage?.createdAt ?? b.createdAt ?? 0;
    return timeB - timeA;
  });
}
