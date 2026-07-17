import type { Chat } from './api';

/** Direct chat that includes the admin (support chat), either side. */
export function isAdminSupportChat(chat: Chat): boolean {
  if (chat.type !== 'direct') return false;
  return chat.members.some((m) => m.isAdmin);
}

/** Direct chat with an admin peer (from the current user's perspective). */
function isAdminDirectChat(chat: Chat, currentUserId: string): boolean {
  if (!isAdminSupportChat(chat)) return false;
  return chat.members.some((m) => m.id !== currentUserId && m.isAdmin);
}

/** Chats shown in the main list — admin support DM is hidden for non-admins. */
export function visibleChatsForUser(chats: Chat[], currentUserId: string, isAdmin: boolean): Chat[] {
  if (isAdmin) return chats;
  return chats.filter((c) => !isAdminDirectChat(c, currentUserId));
}
