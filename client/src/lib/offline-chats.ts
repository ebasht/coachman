import type { Chat } from './api';
import { getChats, getMessages, getMessageChatIds, saveChat, type StoredChat, type StoredMessage } from './storage';
import { messagePreview } from './chat-format';

async function previewForChat(chatId: string): Promise<string | undefined> {
  const messages = await getMessages(chatId);
  const latest = messages
    .filter((m) => !m.pending)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  return latest ? messagePreview(latest) : undefined;
}

export async function enrichChatsWithPreviews(chats: Chat[]): Promise<Chat[]> {
  return Promise.all(
    chats.map(async (chat) => ({
      ...chat,
      lastMessagePreview: await previewForChat(chat.id),
    })),
  );
}

export async function saveChatFromApi(chat: Chat) {
  await saveChat({
    id: chat.id,
    type: chat.type,
    displayName: chat.displayName,
    isSystem: chat.isSystem,
    groupKeyEpoch: chat.groupKeyEpoch,
    members: chat.members,
    lastMessageAt: chat.lastMessage?.createdAt,
    lastMessage: chat.lastMessage ?? undefined,
    peerLastReadAt: chat.peerLastReadAt,
    createdAt: chat.createdAt,
  });
}

function toChat(
  stored: StoredChat,
  lastMessage?: { id: string; senderId: string; type: string; createdAt: number },
  latestMessage?: StoredMessage,
): Chat {
  const resolved = stored.lastMessage ?? lastMessage ?? null;
  return {
    id: stored.id,
    type: stored.type,
    name: stored.type === 'group' ? stored.displayName : null,
    displayName: stored.displayName,
    isSystem: stored.isSystem,
    groupKeyEpoch: stored.groupKeyEpoch,
    members: stored.members,
    lastMessage: resolved,
    lastMessagePreview: latestMessage ? messagePreview(latestMessage) : undefined,
    peerLastReadAt: stored.peerLastReadAt,
    createdAt: stored.createdAt ?? stored.lastMessageAt ?? resolved?.createdAt ?? 0,
  };
}

export async function chatsFromLocalStore(): Promise<Chat[]> {
  let stored = await getChats();

  if (stored.length === 0) {
    const chatIds = await getMessageChatIds();
    stored = chatIds.map((id) => ({
      id,
      type: 'direct' as const,
      displayName: 'Чат',
      members: [],
    }));
  }

  const chats = await Promise.all(
    stored.map(async (chat) => {
      const messages = await getMessages(chat.id);
      const latest = messages.sort((a, b) => b.createdAt - a.createdAt)[0];
      const lastMessage = latest
        ? { id: latest.id, senderId: latest.senderId, type: latest.type, createdAt: latest.createdAt }
        : chat.lastMessage;
      return toChat(chat, lastMessage, latest);
    }),
  );

  return chats.sort((a, b) => {
    const timeA = a.lastMessage?.createdAt ?? a.createdAt ?? 0;
    const timeB = b.lastMessage?.createdAt ?? b.createdAt ?? 0;
    return timeB - timeA;
  });
}
