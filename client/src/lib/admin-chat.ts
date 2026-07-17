import type { Chat } from './api';

/** Direct chat that includes the admin (support chat), either side. */
export function isAdminSupportChat(chat: Chat): boolean {
  if (chat.type !== 'direct') return false;
  return chat.members.some((m) => m.isAdmin);
}

/** All chats — support DMs with admin are shown like normal chats in the list. */
export function visibleChatsForUser(chats: Chat[], _currentUserId: string, _isAdmin: boolean): Chat[] {
  return chats;
}
