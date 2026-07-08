import { useMemo } from 'react';
import type { Chat } from '../lib/api';
import { Notice } from './Notice';

interface Props {
  chats: Chat[];
  activeId: string | null;
  unreadCounts: Record<string, number>;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onInvite: () => void;
  onInviteGraph?: () => void;
  onLogout: () => void;
  onDeleteAccount: () => void;
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
  onLogout,
  onDeleteAccount,
  pushPermission = 'unsupported',
  pushNeedsPWAInstall = false,
  onEnablePush,
  username,
  online,
}: Props) {
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

  return (
    <aside className="chat-list">
      {!online && (
        <Notice variant="warning">Нет интернета. Сообщения будут отправлены позже.</Notice>
      )}
      {pushNeedsPWAInstall && (
        <Notice variant="info">
          Для уведомлений откройте Ямщик через иконку на экране «Домой» (не из Safari).
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
      <header>
        <div>
          <h2>Чаты</h2>
          <span className={`status ${online ? 'online' : 'offline'}`}>
            {online ? 'онлайн' : 'офлайн'}
          </span>
        </div>
        <div className="header-actions">
          <button type="button" className="icon-btn" onClick={onInvite} title="Пригласить">
            🔗
          </button>
          {onInviteGraph && (
            <button type="button" className="icon-btn" onClick={onInviteGraph} title="Граф приглашений">
              🕸
            </button>
          )}
          <button type="button" className="icon-btn" onClick={onNewChat} title="Новый чат">
            +
          </button>
          <button type="button" className="logout-btn" onClick={onLogout} title="Выйти">
            Выйти
          </button>
        </div>
      </header>
      <p className="current-user">
        @{username}
        <button type="button" className="delete-account-link" onClick={onDeleteAccount}>
          Удалить аккаунт
        </button>
      </p>

      <ul>
        {sortedChats.length === 0 && (
          <li className="empty">В круге пока никого нет. Пригласите друзей по ссылке 🔗</li>
        )}
        {sortedChats.map((chat) => {
          const unread = unreadCounts[chat.id] ?? 0;
          return (
          <li key={chat.id}>
            <button
              type="button"
              className={[chat.id === activeId ? 'active' : '', unread > 0 ? 'has-unread' : ''].filter(Boolean).join(' ')}
              onClick={() => onSelect(chat.id)}
            >
              <span className="chat-icon">{chat.type === 'group' ? '👥' : '💬'}</span>
              <span className="chat-info">
                <span className="chat-name">{chat.displayName}</span>
                {chat.lastMessage && (
                  <span className="chat-preview">
                    {chat.lastMessage.type === 'image' ? '📷 Фото' : 'Сообщение'}
                  </span>
                )}
              </span>
              {unread > 0 && (
                <span className="unread-badge" aria-label={`${unread} непрочитанных`}>
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </button>
          </li>
          );
        })}
      </ul>
    </aside>
  );
}
