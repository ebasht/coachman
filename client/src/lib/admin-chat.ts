import type { Chat } from './api';

/** All chats are shown the same way regardless of admin membership. */
export function visibleChatsForUser(chats: Chat[], _currentUserId: string, _isAdmin: boolean): Chat[] {
  return chats;
}
