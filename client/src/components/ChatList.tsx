import { useMemo } from 'react';
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
  onAdminUsers,
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
      <header className="chat-list-header">
        <div className="chat-list-title">
          <h2>Чаты</h2>
          <span className={`status-pill ${online ? 'online' : 'offline'}`}>
            {online ? 'в сети' : 'офлайн'}
          </span>
        </div>
        <div className="header-actions">
          <button type="button" className="icon-btn" onClick={onInvite} title="Пригласить" aria-label="Пригласить">
            🔗
          </button>
          {onInviteGraph && (
            <button type="button" className="icon-btn" onClick={onInviteGraph} title="Граф приглашений" aria-label="Граф приглашений">
              🕸
            </button>
          )}
          {onAdminUsers && (
            <button type="button" className="icon-btn" onClick={onAdminUsers} title="Пользователи" aria-label="Пользователи">
              👤
            </button>
          )}
          <button type="button" className="icon-btn icon-btn-accent" onClick={onNewChat} title="Новый чат" aria-label="Новый чат">
            ✎
          </button>
        </div>
      </header>

      <div className="chat-list-account">
        <span className="chat-list-account-avatar" aria-hidden>{chatInitials(username)}</span>
        <div className="chat-list-account-info">
          <span className="chat-list-account-name">@{username}</span>
          <div className="chat-list-account-actions">
            <button type="button" className="text-btn" onClick={onLogout}>Выйти</button>
            <span className="dot-sep">·</span>
            <button type="button" className="text-btn danger-text" onClick={onDeleteAccount}>Удалить аккаунт</button>
          </div>
        </div>
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
        {sortedChats.length === 0 && (
          <li className="chat-list-empty">В круге пока никого нет. Пригласите друзей по ссылке.</li>
        )}
        {sortedChats.map((chat) => {
          const unread = unreadCounts[chat.id] ?? 0;
          const lastAt = chat.lastMessage?.createdAt;
          const preview = chat.lastMessagePreview
            ?? (chat.lastMessage?.type === 'image' ? 'Фото' : chat.lastMessage ? 'Сообщение' : 'Нет сообщений');
          return (
            <li key={chat.id}>
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
