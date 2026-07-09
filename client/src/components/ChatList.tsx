import { useMemo, useState } from 'react';
import type { Chat } from '../lib/api';
import { chatInitials, formatChatListTime } from '../lib/chat-format';
import { Notice } from './Notice';

interface Props {
  chats: Chat[];
  activeId: string | null;
  unreadCounts: Record<string, number>;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onInvite: () => void;
  onInviteGraph?: () => void;
  onAdminUsers?: () => void;
  onLogout: () => void;
  pushPermission?: NotificationPermission | 'unsupported';
  pushNeedsPWAInstall?: boolean;
  onEnablePush?: () => void;
  username: string;
  online: boolean;
}

export function ChatList({
  chats,
  activeId,
  unreadCounts,
  onSelect,
  onNewChat,
  onInvite,
  onInviteGraph,
  onAdminUsers,
  onLogout,
  pushPermission = 'unsupported',
  pushNeedsPWAInstall = false,
  onEnablePush,
  username,
  online,
}: Props) {
  const [query, setQuery] = useState('');

  const sortedChats = useMemo(() => {
    return [...chats].sort((a, b) => {
      const unreadA = (unreadCounts[a.id] ?? 0) > 0 ? 1 : 0;
      const unreadB = (unreadCounts[b.id] ?? 0) > 0 ? 1 : 0;
      if (unreadA !== unreadB) return unreadB - unreadA;
      const timeA = a.lastMessage?.createdAt ?? a.createdAt ?? 0;
      const timeB = b.lastMessage?.createdAt ?? b.createdAt ?? 0;
      return timeB - timeA;
    });
  }, [chats, unreadCounts]);

  const visibleChats = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sortedChats;
    return sortedChats.filter((c) => c.displayName.toLowerCase().includes(q));
  }, [sortedChats, query]);

  return (
    <aside className="chat-list">
      <header className="chat-list-header">
        <button type="button" className="tg-header-profile" onClick={onLogout} title="Выйти" aria-label="Аккаунт">
          <span className="chat-list-account-avatar" aria-hidden>{chatInitials(username)}</span>
        </button>
        <h2 className="tg-header-title">Чаты</h2>
        <div className="tg-header-actions">
          <button type="button" className="tg-header-btn" onClick={onInvite} title="Пригласить" aria-label="Пригласить">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden><path fill="currentColor" d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
          </button>
          {onInviteGraph && (
            <button type="button" className="tg-header-btn" onClick={onInviteGraph} title="Граф" aria-label="Граф приглашений">
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
            </button>
          )}
          {onAdminUsers && (
            <button type="button" className="tg-header-btn" onClick={onAdminUsers} title="Пользователи" aria-label="Пользователи">
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
            </button>
          )}
          <button type="button" className="tg-header-btn tg-header-btn-compose" onClick={onNewChat} title="Новый чат" aria-label="Новый чат">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
          </button>
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
            ?? (chat.lastMessage?.type === 'image' ? 'Фото' : chat.lastMessage ? 'Сообщение' : 'Нет сообщений');
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
                <span
                  className={`chat-avatar ${chat.type === 'group' ? 'group' : ''}`}
                  aria-hidden
                >
                  {chat.type === 'group' ? '👥' : chatInitials(chat.displayName)}
                </span>
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
