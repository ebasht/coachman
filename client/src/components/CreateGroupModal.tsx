import { useState, useEffect } from 'react';
import { api, type User } from '../lib/api';
import { notify } from '../lib/notify';
import { Notice } from './Notice';
import { UserAvatar } from './UserAvatar';
import {
  generateGroupKey,
  exportGroupKey,
  wrapGroupKeyForMember,
  importPublicKey,
} from '../lib/crypto';

interface Props {
  currentUserId: string;
  privateKey: CryptoKey;
  publicKey: string;
  onCreated: (chatId: string) => void;
  onClose: () => void;
}

export function CreateGroupModal({ currentUserId, privateKey, publicKey, onCreated, onClose }: Props) {
  const [name, setName] = useState('');
  const [circle, setCircle] = useState<User[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [loadingCircle, setLoadingCircle] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getCircle()
      .then((list) =>
        setCircle(list.filter((u) => u.id !== currentUserId && !u.isAdmin)),
      )
      .catch(() => setCircle([]))
      .finally(() => setLoadingCircle(false));
  }, [currentUserId]);

  const toggle = (userId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const create = async () => {
    if (!name.trim() || selectedIds.size === 0) {
      const message = 'Укажите название и отметьте участников';
      setError(message);
      notify.warning(message);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const groupKey = await generateGroupKey();
      const groupKeyRaw = await exportGroupKey(groupKey);
      const myPub = await importPublicKey(publicKey);
      const selected = circle.filter((u) => selectedIds.has(u.id));

      const allMembers = [
        { id: currentUserId, publicKey },
        ...selected.map((u) => ({ id: u.id, publicKey: u.publicKey })),
      ];

      const members = await Promise.all(
        allMembers.map(async (m) => {
          const memberPub = m.id === currentUserId ? myPub : await importPublicKey(m.publicKey);
          const encryptedGroupKey = await wrapGroupKeyForMember(
            groupKeyRaw,
            privateKey,
            memberPub,
            currentUserId,
          );
          return { userId: m.id, encryptedGroupKey };
        }),
      );

      const { id } = await api.createGroup(name.trim(), members);
      const { saveGroupKeyWithEpoch } = await import('../lib/storage');
      await saveGroupKeyWithEpoch(currentUserId, id, groupKeyRaw, 1);
      onCreated(id);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Ошибка создания группы';
      setError(message);
      notify.error(message);
    }
    setLoading(false);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Новая группа</h2>
        <p className="modal-subtitle">Название и участники из вашего круга</p>

        <input
          type="text"
          placeholder="Название группы"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus={typeof window !== 'undefined' && !('ontouchstart' in window)}
        />

        {loadingCircle && <p className="hint">Загрузка участников...</p>}

        {!loadingCircle && circle.length === 0 && (
          <p className="hint">В круге пока никого нет. Пригласите друзей по ссылке.</p>
        )}

        <ul className="user-list member-pick-list">
          {circle.map((u) => {
            const checked = selectedIds.has(u.id);
            return (
              <li key={u.id}>
                <label className={`member-pick ${checked ? 'selected' : ''}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(u.id)}
                  />
                  <UserAvatar
                    userId={u.id}
                    name={u.username}
                    hasAvatar={u.hasAvatar}
                    avatarUpdatedAt={u.avatarUpdatedAt}
                    avatarUrl={u.avatarUrl}
                    className="member-pick-avatar"
                  />
                  <span className="member-pick-name">{u.username}</span>
                </label>
              </li>
            );
          })}
        </ul>

        {error && <Notice variant="error">{error}</Notice>}

        <div className="modal-actions">
          <button type="button" className="link-btn" onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void create()}
            disabled={loading || selectedIds.size === 0 || !name.trim()}
          >
            {loading ? 'Создание...' : 'Создать'}
          </button>
        </div>
      </div>
    </div>
  );
}
