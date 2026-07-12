import { useMemo, useState } from 'react';
import type { Chat } from '../lib/api';
import { chatInitials, formatChatListTime } from '../lib/chat-format';
import { UserAvatar } from './UserAvatar';
import { Notice } from './Notice';

interface Props {
  chats: Chat[];
  activeId: string | null;
  unreadCounts: Record<string, number>;
  onSelect: (id: string) => void;
  /** Regular users: open create-group. Admin: omit — DMs are in the chat list. */
  onCreateGroup?: () => void;
  onSettings: () => void;
  settingsUnread?: number;
  pushPermission?: NotificationPermission | 'unsupported';
  pushNeedsPWAInstall?: boolean;
  onEnablePush?: () => void;
  userId: string;
  username: string;
  hasAvatar?: boolean;
  avatarUpdatedAt?: number | null;
  avatarUrl?: string | null;
  online: boolean;
}

export function ChatList({
  chats,
  activeId,
  unreadCounts,
  onSelect,
  onCreateGroup,
  onSettings,
  settingsUnread = 0,
  pushPermission = 'unsupported',
  pushNeedsPWAInstall = false,
  onEnablePush,
  userId,
  username,
  hasAvatar = false,
  avatarUpdatedAt = null,
  avatarUrl = null,
  online,
}: Props) {
  const [query, setQuery] = useState('');

  const sortedChats = useMemo(() => {
    return [...chats].sort((a, b) => {
      if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
      // Keep order by activity only — sorting by unread made the list jump on every refresh.
      const timeA = a.lastMessage?.createdAt ?? a.createdAt ?? 0;
      const timeB = b.lastMessage?.createdAt ?? b.createdAt ?? 0;
      if (timeA !== timeB) return timeB - timeA;
      return a.id.localeCompare(b.id);
    });
  }, [chats]);

  const visibleChats = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sortedChats;
    return sortedChats.filter((c) => c.displayName.toLowerCase().includes(q));
  }, [sortedChats, query]);

  return (
    <aside className="chat-list">
      <header className="chat-list-header">
        <button
          type="button"
          className="tg-header-profile"
          onClick={onSettings}
          title="Настройки"
          aria-label="Настройки"
        >
          <UserAvatar
            userId={userId}
            name={username}
            hasAvatar={hasAvatar}
            avatarUpdatedAt={avatarUpdatedAt}
            avatarUrl={avatarUrl}
            className="chat-list-account-avatar"
          />
          {settingsUnread > 0 && (
            <span className="settings-unread-dot" aria-hidden />
          )}
        </button>
        <h2 className="tg-header-title">Чаты</h2>
        <div className="tg-header-actions">
          {onCreateGroup && (
            <button
              type="button"
              className="tg-header-btn tg-header-btn-compose"
              onClick={onCreateGroup}
              title="Создать группу"
              aria-label="Создать группу"
            >
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
            </button>
          )}
        </div>
      </header>

      <div className="chat-list-search-wrap">
        <div className="chat-list-search">
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden><path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
          <input
            type="search"
            placeholder="Поиск"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
        </div>
        {!online && <span className="tg-offline-chip">офлайн</span>}
      </div>

      <div className="chat-list-notices">
        {!online && (
          <Notice variant="warning">Нет интернета. Сообщения отправятся позже.</Notice>
        )}
        {pushNeedsPWAInstall && (
          <Notice variant="info">
            Для уведомлений откройте Ямщик через иконку на экране «Домой».
          </Notice>
        )}
        {pushPermission === 'denied' && (
          <Notice variant="warning">
            Уведомления запрещены. Включите в Настройки → Уведомления → Ямщик.
          </Notice>
        )}
        {!pushNeedsPWAInstall && pushPermission === 'default' && onEnablePush && (
          <Notice variant="info">
            <span>Уведомления в фоне выключены.</span>
            <button
              type="button"
              className="notice-action"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onEnablePush();
              }}
            >
              Включить
            </button>
          </Notice>
        )}
      </div>

      <ul className="chat-list-items">
        {visibleChats.length === 0 && (
          <li className="chat-list-empty">
            {query.trim() ? 'Ничего не найдено' : 'В круге пока никого нет. Пригласите друзей по ссылке.'}
          </li>
        )}
        {visibleChats.map((chat) => {
          const unread = unreadCounts[chat.id] ?? 0;
          const lastAt = chat.lastMessage?.createdAt;
          const preview = chat.lastMessagePreview
            ?? (chat.lastMessage?.type === 'image'
              ? 'Фото'
              : chat.lastMessage?.type === 'call'
                ? 'Видеозвонок'
                : chat.lastMessage
                  ? 'Сообщение'
                  : 'Нет сообщений');
          const peer = chat.type === 'direct'
            ? chat.members.find((m) => m.id !== userId)
            : undefined;
          return (
            <li key={chat.id} className="chat-list-item">
              <button
                type="button"
                className={[
                  'chat-row',
                  chat.id === activeId ? 'active' : '',
                  unread > 0 ? 'has-unread' : '',
                ].filter(Boolean).join(' ')}
                onClick={() => onSelect(chat.id)}
              >
                {chat.type === 'group' ? (
                  <span className="chat-avatar group" aria-hidden>
                    {chat.isSystem ? '🌐' : '👥'}
                  </span>
                ) : peer ? (
                  <UserAvatar
                    userId={peer.id}
                    name={chat.displayName}
                    hasAvatar={peer.hasAvatar}
                    avatarUpdatedAt={peer.avatarUpdatedAt}
                    avatarUrl={peer.avatarUrl}
                    className="chat-avatar"
                  />
                ) : (
                  <span className="chat-avatar" aria-hidden>
                    {chatInitials(chat.displayName)}
                  </span>
                )}
                <span className="chat-info">
                  <span className="chat-row-top">
                    <span className="chat-name">{chat.displayName}</span>
                    {lastAt ? (
                      <span className="chat-time">{formatChatListTime(lastAt)}</span>
                    ) : null}
                  </span>
                  <span className="chat-row-bottom">
                    <span className="chat-preview">{preview}</span>
                    {unread > 0 && (
                      <span className="unread-badge" aria-label={`${unread} непрочитанных`}>
                        {unread > 99 ? '99+' : unread}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
