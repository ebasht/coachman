import { useState, useEffect, useMemo, useRef } from 'react';
import { api, type Chat, type User } from '../lib/api';
import { buildGroupKeyRotation } from '../lib/group-key';
import { saveGroupKeyWithEpoch, deleteChatLocal } from '../lib/storage';
import { peerStatusText } from '../lib/chat-format';
import { notify } from '../lib/notify';
import { prepareAvatarFile } from '../lib/prepare-avatar';
import { invalidateChatAvatarCache } from '../hooks/useChatAvatarUrl';
import { Notice } from './Notice';
import { UserAvatar } from './UserAvatar';
import { ChatAvatar } from './ChatAvatar';

interface Props {
  chat: Chat;
  currentUserId: string;
  privateKey: CryptoKey;
  isAdmin?: boolean;
  onClose: () => void;
  onUpdated: (left?: boolean) => void;
  /** Reload chat without closing (e.g. after avatar change). */
  onChatChanged?: () => void;
}

export function GroupMembersModal({
  chat,
  currentUserId,
  privateKey,
  isAdmin = false,
  onClose,
  onUpdated,
  onChatChanged,
}: Props) {
  const [circle, setCircle] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [error, setError] = useState('');
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const isCreator = chat.createdByUserId === currentUserId;
  const isSystem = !!chat.isSystem;
  const canManage = isCreator && !isSystem;
  const canSetAvatar = (isSystem && isAdmin) || (isCreator && !isSystem);
  const memberIds = useMemo(() => new Set(chat.members.map((m) => m.id)), [chat.members]);
  const hasChatAvatar = !!(chat.hasAvatar || chat.avatarUpdatedAt || chat.avatarUrl);

  useEffect(() => {
    if (!canManage) return;
    api.getCircle()
      .then((list) =>
        setCircle(list.filter((u) => !memberIds.has(u.id) && !u.isAdmin)),
      )
      .catch(() => setCircle([]));
  }, [memberIds, canManage]);

  const addMember = async (user: User) => {
    setLoading(true);
    setError('');
    try {
      const expandedChat: Chat = {
        ...chat,
        members: [
          ...chat.members,
          { id: user.id, username: user.username, publicKey: user.publicKey },
        ],
      };
      const allIds = expandedChat.members.map((m) => m.id);
      const { keyRaw, wraps, nextEpoch } = await buildGroupKeyRotation(
        expandedChat,
        allIds,
        currentUserId,
        privateKey,
      );
      const newWrap = wraps.find((w) => w.userId === user.id)!;
      const existingWraps = wraps.filter((w) => w.userId !== user.id);

      await api.addGroupMember(chat.id, user.id, newWrap.encryptedGroupKey, {
        rekeyEpoch: nextEpoch,
        memberKeys: existingWraps,
      });
      await saveGroupKeyWithEpoch(currentUserId, chat.id, keyRaw, nextEpoch);
      onUpdated();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Не удалось добавить участника';
      setError(message);
      notify.error(message);
    }
    setLoading(false);
  };

  const removeMember = async (userId: string, username: string) => {
    if (!window.confirm(`Удалить ${username} из группы?`)) return;

    setLoading(true);
    setError('');
    try {
      const remaining = chat.members.filter((m) => m.id !== userId);
      const shrunkChat: Chat = { ...chat, members: remaining };
      const remainingIds = remaining.map((m) => m.id);
      const { keyRaw, wraps, nextEpoch } = await buildGroupKeyRotation(
        shrunkChat,
        remainingIds,
        currentUserId,
        privateKey,
      );
      await api.removeGroupMember(chat.id, userId, {
        rekeyEpoch: nextEpoch,
        memberKeys: wraps,
      });
      await saveGroupKeyWithEpoch(currentUserId, chat.id, keyRaw, nextEpoch);
      onUpdated();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Не удалось удалить участника';
      setError(message);
      notify.error(message);
    }
    setLoading(false);
  };

  const deleteGroup = async () => {
    if (!window.confirm(`Удалить группу «${chat.displayName}» для всех участников?`)) return;

    setLoading(true);
    setError('');
    try {
      await api.deleteChat(chat.id);
      await deleteChatLocal(chat.id, currentUserId);
      onUpdated(true);
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Не удалось удалить группу';
      setError(message);
      notify.error(message);
    }
    setLoading(false);
  };

  const onPickAvatar = async (file: File | undefined) => {
    if (!file || avatarBusy) return;
    setAvatarBusy(true);
    setError('');
    try {
      const blob = await prepareAvatarFile(file);
      await api.uploadChatAvatar(chat.id, blob);
      invalidateChatAvatarCache(chat.id);
      notify.success('Фото чата обновлено');
      if (onChatChanged) onChatChanged();
      else onUpdated();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Не удалось загрузить фото';
      setError(message);
      notify.error(message);
    } finally {
      setAvatarBusy(false);
      if (avatarInputRef.current) avatarInputRef.current.value = '';
    }
  };

  const onClearAvatar = async () => {
    if (avatarBusy || !hasChatAvatar) return;
    if (!window.confirm('Убрать фото чата?')) return;
    setAvatarBusy(true);
    setError('');
    try {
      await api.deleteChatAvatar(chat.id);
      invalidateChatAvatarCache(chat.id);
      notify.success('Фото чата удалено');
      if (onChatChanged) onChatChanged();
      else onUpdated();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Не удалось удалить фото';
      setError(message);
      notify.error(message);
    } finally {
      setAvatarBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal group-members-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{canManage ? 'Редактирование группы' : 'Участники'}</h2>
        <p className="modal-subtitle">
          {chat.displayName}
          {isSystem ? ' · общий чат для всех' : ''}
          {canManage ? ' · вы создатель' : ''}
        </p>

        {canSetAvatar && (
          <div className="group-chat-avatar-edit">
            <ChatAvatar
              chatId={chat.id}
              name={chat.displayName}
              isSystem={isSystem}
              hasAvatar={chat.hasAvatar}
              avatarUpdatedAt={chat.avatarUpdatedAt}
              avatarUrl={chat.avatarUrl}
              className="group-chat-avatar-preview"
            />
            <div className="group-chat-avatar-actions">
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/*"
                hidden
                onChange={(e) => void onPickAvatar(e.target.files?.[0])}
              />
              <button
                type="button"
                className="admin-user-avatar-btn"
                disabled={avatarBusy || loading}
                onClick={() => avatarInputRef.current?.click()}
              >
                {avatarBusy ? 'Загрузка…' : hasChatAvatar ? 'Сменить фото' : 'Назначить фото'}
              </button>
              {hasChatAvatar && (
                <button
                  type="button"
                  className="admin-user-avatar-btn admin-user-avatar-btn-muted"
                  disabled={avatarBusy || loading}
                  onClick={() => void onClearAvatar()}
                >
                  Убрать
                </button>
              )}
            </div>
          </div>
        )}

        <ul className="member-list">
          {chat.members.map((m) => {
            const isSelf = m.id === currentUserId;
            const status = peerStatusText({
              online: isSelf || !!m.online,
              lastSeenAt: m.lastSeenAt,
            });
            const statusOnline = isSelf || !!m.online;
            return (
              <li key={m.id}>
                <UserAvatar
                  userId={m.id}
                  name={m.username}
                  hasAvatar={m.hasAvatar}
                  avatarUpdatedAt={m.avatarUpdatedAt}
                  avatarUrl={m.avatarUrl}
                  className="member-avatar"
                />
                <span className="member-main">
                  <span className="member-name">
                    {m.username}
                    {isSelf && <span className="member-you"> (вы)</span>}
                    {!isSystem && m.id === chat.createdByUserId && (
                      <span className="member-you"> · создатель</span>
                    )}
                  </span>
                  <span className={`member-status${statusOnline ? ' is-online' : ''}`}>
                    {status}
                  </span>
                </span>
                {canManage && !isSelf && (
                  <button
                    type="button"
                    className="member-remove"
                    disabled={loading}
                    onClick={() => void removeMember(m.id, m.username)}
                    title="Удалить"
                  >
                    ×
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        {canManage && (
          <div className="add-member-section">
            <p className="add-member-title">Добавить участников</p>
            {circle.length === 0 ? (
              <p className="hint">Больше некого добавить из круга</p>
            ) : (
              <ul className="user-list member-pick-list">
                {circle.map((u) => (
                  <li key={u.id}>
                    <button
                      type="button"
                      className="member-pick"
                      disabled={loading}
                      onClick={() => void addMember(u)}
                    >
                      <UserAvatar
                        userId={u.id}
                        name={u.username}
                        hasAvatar={u.hasAvatar}
                        avatarUpdatedAt={u.avatarUpdatedAt}
                        avatarUrl={u.avatarUrl}
                        className="member-pick-avatar"
                      />
                      <span className="member-pick-name">{u.username}</span>
                      <span className="member-pick-add">+</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {error && <Notice variant="error">{error}</Notice>}

        <div className="modal-actions">
          {canManage && (
            <button
              type="button"
              className="danger-btn"
              disabled={loading}
              onClick={() => void deleteGroup()}
            >
              Удалить группу
            </button>
          )}
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
