import { useState, useEffect } from 'react';
import { api, type Chat, type User } from '../lib/api';
import { buildGroupKeyRotation } from '../lib/group-key';
import { deleteGroupKey, saveGroupKeyWithEpoch } from '../lib/storage';
import { notify } from '../lib/notify';
import { Notice } from './Notice';

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
  const [query, setQuery] = useState('');
  const [circle, setCircle] = useState<User[]>([]);
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const isCreator = chat.createdByUserId === currentUserId;
  const memberIds = new Set(chat.members.map((m) => m.id));

  useEffect(() => {
    if (!isCreator) return;
    api.getCircle()
      .then((list) => setCircle(list.filter((u) => !memberIds.has(u.id))))
      .catch(() => setCircle([]));
  }, [chat.members, isCreator]);

  const search = (q: string) => {
    setQuery(q);
    const filtered = circle.filter((u) => !q || u.username.includes(q.toLowerCase()));
    setSearchResults(q.length >= 1 ? filtered : []);
  };

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
        privateKey
      );
      const newWrap = wraps.find((w) => w.userId === user.id)!;
      const existingWraps = wraps.filter((w) => w.userId !== user.id);

      await api.addGroupMember(chat.id, user.id, newWrap.encryptedGroupKey, {
        rekeyEpoch: nextEpoch,
        memberKeys: existingWraps,
      });
      await saveGroupKeyWithEpoch(chat.id, keyRaw, nextEpoch);
      setQuery('');
      setSearchResults([]);
      onUpdated();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Не удалось добавить участника';
      setError(message);
      notify.error(message);
    }
    setLoading(false);
  };

  const removeMember = async (userId: string, username: string) => {
    if (!window.confirm(`Удалить @${username} из группы?`)) return;

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
        privateKey
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
      await api.deleteGroup(chat.id);
      await deleteGroupKey(chat.id);
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
        <h2>Участники</h2>
        <p className="modal-subtitle">{chat.displayName}</p>

        <ul className="member-list">
          {chat.members.map((m) => (
            <li key={m.id}>
              <span className="member-avatar">{m.username[0]?.toUpperCase()}</span>
              <span className="member-name">
                @{m.username}
                {m.id === currentUserId && <span className="member-you"> (вы)</span>}
                {m.id === chat.createdByUserId && <span className="member-you"> · создатель</span>}
              </span>
              {isCreator && m.id !== currentUserId && (
                <button
                  type="button"
                  className="member-remove"
                  disabled={loading}
                  onClick={() => removeMember(m.id, m.username)}
                  title="Удалить"
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>

        {isCreator && (
          <div className="add-member-section">
            <input
              type="text"
              placeholder="Добавить по имени..."
              value={query}
              onChange={(e) => search(e.target.value)}
              disabled={loading}
            />
            {searchResults.length > 0 && (
              <ul className="user-list">
                {searchResults.map((u) => (
                  <li key={u.id}>
                    <button type="button" onClick={() => addMember(u)} disabled={loading}>
                      + {u.username}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {error && <Notice variant="error">{error}</Notice>}

        <div className="modal-actions">
          {isCreator && (
            <button type="button" className="danger-btn" disabled={loading} onClick={deleteGroup}>
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
