import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AdminUser } from '../lib/api';
import { notify } from '../lib/notify';
import { Notice } from './Notice';
import { UserAvatar } from './UserAvatar';
import { prepareAvatarFile } from '../lib/prepare-avatar';
import { invalidateAvatarCache } from '../hooks/useAvatarUrl';

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
  const [avatarBusyId, setAvatarBusyId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingUserIdRef = useRef<string | null>(null);

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

  const pickAvatar = (userId: string) => {
    if (avatarBusyId) return;
    pendingUserIdRef.current = userId;
    const input = fileInputRef.current;
    if (!input) return;
    input.value = '';
    input.click();
  };

  const onAvatarFile = async (file: File | undefined) => {
    const userId = pendingUserIdRef.current;
    pendingUserIdRef.current = null;
    if (!file || !userId) return;

    setAvatarBusyId(userId);
    try {
      const blob = await prepareAvatarFile(file);
      const result = await api.uploadAdminUserAvatar(userId, blob, 'image/jpeg');
      invalidateAvatarCache(userId);
      setUsers((prev) =>
        prev.map((u) =>
          u.id === userId
            ? {
                ...u,
                hasAvatar: true,
                avatarUpdatedAt: result.avatarUpdatedAt,
                avatarUrl: result.avatarUrl ?? null,
              }
            : u,
        ),
      );
      notify.success('Аватар обновлён');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Не удалось загрузить аватар';
      notify.error(message);
    } finally {
      setAvatarBusyId(null);
    }
  };

  const removeAvatar = async (user: AdminUser) => {
    if (avatarBusyId || !user.hasAvatar) return;
    const confirmed = window.confirm(`Удалить аватар у ${user.username}?`);
    if (!confirmed) return;

    setAvatarBusyId(user.id);
    try {
      await api.deleteAdminUserAvatar(user.id);
      invalidateAvatarCache(user.id);
      setUsers((prev) =>
        prev.map((u) =>
          u.id === user.id
            ? { ...u, hasAvatar: false, avatarUpdatedAt: null, avatarUrl: null }
            : u,
        ),
      );
      notify.success('Аватар удалён');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Не удалось удалить аватар';
      notify.error(message);
    } finally {
      setAvatarBusyId(null);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal admin-users-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Пользователи</h2>
        <p className="modal-subtitle">Управление аккаунтами в системе</p>

        {error && <Notice variant="error">{error}</Notice>}

        {loading && <p className="hint">Загрузка...</p>}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/*"
          hidden
          onChange={(e) => void onAvatarFile(e.target.files?.[0])}
        />

        {!loading && !error && (
          <ul className="admin-user-list">
            {users.map((u) => {
              const isSelf = u.id === currentUserId;
              const canDelete = !isSelf && !u.isAdmin;
              const busy = avatarBusyId === u.id;
              return (
                <li key={u.id} className="admin-user-row">
                  <div className="admin-user-main">
                    <UserAvatar
                      userId={u.id}
                      name={u.username}
                      hasAvatar={!!u.hasAvatar}
                      avatarUpdatedAt={u.avatarUpdatedAt}
                      avatarUrl={u.avatarUrl}
                      className="admin-user-avatar"
                    />
                    <div className="admin-user-info">
                      <span className="admin-user-name">
                        {u.username}
                        {u.isAdmin && <span className="admin-badge"> admin</span>}
                        {isSelf && <span className="admin-self-badge"> вы</span>}
                      </span>
                      <div className="admin-user-avatar-actions">
                        <button
                          type="button"
                          className="admin-user-avatar-btn"
                          disabled={busy || deletingId === u.id}
                          onClick={() => pickAvatar(u.id)}
                        >
                          {busy ? '…' : u.hasAvatar ? 'Сменить фото' : 'Назначить фото'}
                        </button>
                        {u.hasAvatar && (
                          <button
                            type="button"
                            className="admin-user-avatar-btn admin-user-avatar-btn-muted"
                            disabled={busy || deletingId === u.id}
                            onClick={() => void removeAvatar(u)}
                          >
                            Удалить фото
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                  {canDelete ? (
                    <button
                      type="button"
                      className="danger-btn"
                      disabled={deletingId === u.id || busy}
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
