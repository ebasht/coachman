import { useState, useEffect, useMemo } from 'react';
import { api, type Chat, type User } from '../lib/api';
import { buildGroupKeyRotation } from '../lib/group-key';
import { saveGroupKeyWithEpoch, deleteChatLocal } from '../lib/storage';
import { notify } from '../lib/notify';
import { Notice } from './Notice';
import { UserAvatar } from './UserAvatar';

interface Props {
  chat: Chat;
  currentUserId: string;
  privateKey: CryptoKey;
  onClose: () => void;
  onUpdated: (left?: boolean) => void;
}

export function GroupMembersModal({
  chat,
  currentUserId,
  privateKey,
  onClose,
  onUpdated,
}: Props) {
  const [circle, setCircle] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const isCreator = chat.createdByUserId === currentUserId;
  const isSystem = !!chat.isSystem;
  const canManage = isCreator && !isSystem;
  const memberIds = useMemo(() => new Set(chat.members.map((m) => m.id)), [chat.members]);

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
      await saveGroupKeyWithEpoch(chat.id, keyRaw, nextEpoch);
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
      await saveGroupKeyWithEpoch(chat.id, keyRaw, nextEpoch);
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

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal group-members-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{canManage ? 'Редактирование группы' : 'Участники'}</h2>
        <p className="modal-subtitle">
          {chat.displayName}
          {isSystem ? ' · общий чат для всех' : ''}
          {canManage ? ' · вы создатель' : ''}
        </p>

        <ul className="member-list">
          {chat.members.map((m) => (
            <li key={m.id}>
              <UserAvatar
                userId={m.id}
                name={m.username}
                hasAvatar={m.hasAvatar}
                avatarUpdatedAt={m.avatarUpdatedAt}
                avatarUrl={m.avatarUrl}
                className="member-avatar"
              />
              <span className="member-name">
                {m.username}
                {m.id === currentUserId && <span className="member-you"> (вы)</span>}
                {!isSystem && m.id === chat.createdByUserId && (
                  <span className="member-you"> · создатель</span>
                )}
              </span>
              {canManage && m.id !== currentUserId && (
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
          ))}
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
