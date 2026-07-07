import { useState, useEffect } from 'react';
import { api, type User } from '../lib/api';

interface Props {
  currentUserId: string;
  onSelectUser: (user: User) => void;
  onCreateGroup: () => void;
  onClose: () => void;
}

export function NewChatModal({ currentUserId, onSelectUser, onCreateGroup, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [circle, setCircle] = useState<User[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getCircle()
      .then((list) => setCircle(list.filter((u) => u.id !== currentUserId)))
      .catch(() => setCircle([]))
      .finally(() => setLoading(false));
  }, [currentUserId]);

  useEffect(() => {
    if (!query.trim()) {
      setUsers(circle);
      return;
    }
    const q = query.toLowerCase();
    setUsers(circle.filter((u) => u.username.includes(q)));
  }, [query, circle]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Новый чат</h2>
        <p className="modal-subtitle">Участники вашего круга</p>

        <button type="button" className="group-btn" onClick={onCreateGroup}>
          👥 Создать группу
        </button>

        <input
          type="text"
          placeholder="Фильтр по имени..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />

        {loading && <p className="hint">Загрузка...</p>}

        <ul className="user-list">
          {users.map((u) => (
            <li key={u.id}>
              <button type="button" onClick={() => onSelectUser(u)}>
                {u.username}
                {u.isAdmin && <span className="admin-badge"> admin</span>}
              </button>
            </li>
          ))}
        </ul>

        {!loading && users.length === 0 && (
          <p className="hint">В круге пока никого нет. Пригласите друзей по ссылке.</p>
        )}

        <button type="button" className="link-btn" onClick={onClose}>
          Отмена
        </button>
      </div>
    </div>
  );
}
