import { useState, useEffect } from 'react';
import { api, type User } from '../lib/api';
import { notify } from '../lib/notify';
import { Notice } from './Notice';
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
  const [query, setQuery] = useState('');
  const [circle, setCircle] = useState<User[]>([]);
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [selected, setSelected] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getCircle()
      .then((list) => setCircle(list.filter((u) => u.id !== currentUserId)))
      .catch(() => setCircle([]));
  }, [currentUserId]);

  const search = (q: string) => {
    setQuery(q);
    const filtered = circle.filter(
      (u) => !selected.find((s) => s.id === u.id) && (!q || u.username.includes(q.toLowerCase()))
    );
    setSearchResults(q.length >= 1 ? filtered : []);
  };

  const addMember = (user: User) => {
    setSelected([...selected, user]);
    setSearchResults(searchResults.filter((u) => u.id !== user.id));
    setQuery('');
  };

  const create = async () => {
    if (!name.trim() || selected.length === 0) {
      const message = 'Укажите название и добавьте участников';
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
        })
      );

      const { id } = await api.createGroup(name.trim(), members);
      const { saveGroupKeyWithEpoch } = await import('../lib/storage');
      await saveGroupKeyWithEpoch(id, groupKeyRaw, 1);
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

        <input
          type="text"
          placeholder="Название группы"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <div className="selected-members">
          {selected.map((u) => (
            <span key={u.id} className="chip">
              {u.username}
              <button type="button" onClick={() => setSelected(selected.filter((s) => s.id !== u.id))}>
                ×
              </button>
            </span>
          ))}
        </div>

        <input
          type="text"
          placeholder="Добавить участников..."
          value={query}
          onChange={(e) => search(e.target.value)}
        />

        <ul className="user-list">
          {searchResults.map((u) => (
            <li key={u.id}>
              <button type="button" onClick={() => addMember(u)}>
                {u.username}
              </button>
            </li>
          ))}
        </ul>

        {error && <Notice variant="error">{error}</Notice>}

        <div className="modal-actions">
          <button type="button" className="link-btn" onClick={onClose}>
            Отмена
          </button>
          <button type="button" onClick={create} disabled={loading}>
            {loading ? 'Создание...' : 'Создать'}
          </button>
        </div>
      </div>
    </div>
  );
}
