import type { Chat } from './api';

/** Direct chat with an admin peer (from the current user's perspective). */
export function isAdminDirectChat(chat: Chat, currentUserId: string): boolean {
  if (chat.type !== 'direct') return false;
  return chat.members.some((m) => m.id !== currentUserId && m.isAdmin);
}

export function findAdminDirectChat(chats: Chat[], currentUserId: string): Chat | undefined {
  return chats.find((c) => isAdminDirectChat(c, currentUserId));
}

/** Chats shown in the main list — admin support chat is hidden for non-admins. */
export function visibleChatsForUser(chats: Chat[], currentUserId: string, isAdmin: boolean): Chat[] {
  if (isAdmin) return chats;
  return chats.filter((c) => !isAdminDirectChat(c, currentUserId));
}
