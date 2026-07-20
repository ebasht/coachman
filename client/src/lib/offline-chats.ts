import type { Chat } from './api';
import {
  getChats,
  getMessages,
  saveChat,
  deleteChatLocal,
  type StoredChat,
  type StoredMessage,
} from './storage';
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
    displayName: chat.displayName || chat.name || 'Чат',
    isSystem: chat.isSystem,
    groupKeyEpoch: chat.groupKeyEpoch,
    members: (chat.members || []).map((m) => ({
      id: m.id,
      username: m.username,
      publicKey: m.publicKey,
      isAdmin: m.isAdmin,
      hasAvatar: !!(m.hasAvatar || m.avatarUpdatedAt || m.avatarUrl),
      avatarUpdatedAt: m.avatarUpdatedAt,
      avatarUrl: m.avatarUrl,
      encryptedGroupKey: m.encryptedGroupKey,
    })),
    lastMessageAt: chat.lastMessage?.createdAt,
    lastMessage: chat.lastMessage ?? undefined,
    peerLastReadAt: chat.peerLastReadAt,
    createdAt: chat.createdAt,
  });
}

/**
 * Replace local chat memberships with the authoritative server list.
 * Anything not returned by GET /chats is deleted from IndexedDB (messages included).
 */
export async function replaceLocalChatsFromApi(chats: Chat[], userId?: string) {
  if (!Array.isArray(chats)) return;

  const keep = new Set(chats.map((c) => c?.id).filter((id): id is string => !!id));

  for (const c of chats) {
    if (!c?.id) continue;
    await saveChatFromApi(c);
  }

  const local = await getChats();
  for (const stored of local) {
    if (!keep.has(stored.id)) {
      await deleteChatLocal(stored.id, userId);
    }
  }
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
  const stored = await getChats();

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

/** Upsert one chat that is known to still exist on the server. */
export function upsertChatInList(prev: Chat[], chat: Chat): Chat[] {
  if (!chat?.id) return prev;
  const idx = prev.findIndex((c) => c.id === chat.id);
  if (idx >= 0) {
    const next = prev.slice();
    next[idx] = { ...prev[idx], ...chat };
    return next;
  }
  return [chat, ...prev];
}

export function removeChatFromList(prev: Chat[], chatId: string): Chat[] {
  if (!chatId) return prev;
  const next = prev.filter((c) => c.id !== chatId);
  return next.length === prev.length ? prev : next;
}
