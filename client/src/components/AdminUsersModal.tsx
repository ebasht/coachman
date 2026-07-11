import { useCallback, useEffect, useState } from 'react';
import { api, type AdminUser } from '../lib/api';
import { notify } from '../lib/notify';
import { Notice } from './Notice';

interface Props {
  currentUserId: string;
  onClose: () => void;
  onUserDeleted?: () => void;
}

export function AdminUsersModal({ currentUserId, onClose, onUserDeleted }: Props) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadUsers = useCallback(() => {
    setLoading(true);
    return api.getAdminUsers()
      .then(setUsers)
      .catch((e) => {
        const message = e instanceof Error ? e.message : 'Нет доступа';
        setError(message);
        notify.error(message);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const handleDelete = async (user: AdminUser) => {
    if (user.id === currentUserId) return;
    if (user.isAdmin) return;
    const confirmed = window.confirm(
      `Удалить пользователя ${user.username}? Все его сообщения и чаты будут удалены безвозвратно.`,
    );
    if (!confirmed) return;

    setDeletingId(user.id);
    try {
      await api.deleteAdminUser(user.id);
      notify.success(`Пользователь ${user.username} удалён`);
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
      onUserDeleted?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Не удалось удалить';
      notify.error(message);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal admin-users-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Пользователи</h2>
        <p className="modal-subtitle">Управление аккаунтами в системе</p>

        {error && <Notice variant="error">{error}</Notice>}

        {loading && <p className="hint">Загрузка...</p>}

        {!loading && !error && (
          <ul className="admin-user-list">
            {users.map((u) => {
              const isSelf = u.id === currentUserId;
              const canDelete = !isSelf && !u.isAdmin;
              return (
                <li key={u.id} className="admin-user-row">
                  <div className="admin-user-info">
                    <span className="admin-user-name">
                      {u.username}
                      {u.isAdmin && <span className="admin-badge"> admin</span>}
                      {isSelf && <span className="admin-self-badge"> вы</span>}
                    </span>
                  </div>
                  {canDelete ? (
                    <button
                      type="button"
                      className="danger-btn"
                      disabled={deletingId === u.id}
                      onClick={() => void handleDelete(u)}
                    >
                      {deletingId === u.id ? 'Удаление…' : 'Удалить'}
                    </button>
                  ) : (
                    <span className="admin-user-muted">
                      {isSelf ? '—' : 'защищён'}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {!loading && !error && users.length === 0 && (
          <p className="hint">Пользователей нет.</p>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  );
}
