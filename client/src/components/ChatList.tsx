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
  onEnablePush,
  username,
  online,
}: Props) {
  return (
    <aside className="chat-list">
      {!online && (
        <Notice variant="warning">Нет интернета. Сообщения будут отправлены позже.</Notice>
      )}
      {pushPermission !== 'granted' && pushPermission !== 'unsupported' && onEnablePush && (
        <Notice variant="info">
          <span>Уведомления в фоне выключены.</span>
          <button type="button" className="notice-action" onClick={onEnablePush}>
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
        {chats.length === 0 && (
          <li className="empty">В круге пока никого нет. Пригласите друзей по ссылке 🔗</li>
        )}
        {chats.map((chat) => {
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
