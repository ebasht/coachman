import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { notify } from '../lib/notify';
import { prepareAvatarFile } from '../lib/prepare-avatar';
import { APP_VERSION } from '../lib/version';
import { invalidateAvatarCache } from '../hooks/useAvatarUrl';
import { UserAvatar } from './UserAvatar';
import { Notice } from './Notice';

interface Props {
  userId: string;
  username: string;
  hasAvatar?: boolean;
  avatarUpdatedAt?: number | null;
  avatarUrl?: string | null;
  isAdmin: boolean;
  adminChatUnread?: number;
  onOpenAdminChat?: () => void;
  onInvite?: () => void;
  onAdminUsers?: () => void;
  onAvatarChange?: (next: {
    hasAvatar: boolean;
    avatarUpdatedAt: number | null;
    avatarUrl: string | null;
  }) => void;
  onLogout: () => void;
  onClose: () => void;
}

export function SettingsModal({
  userId,
  username,
  hasAvatar = false,
  avatarUpdatedAt = null,
  avatarUrl = null,
  isAdmin,
  adminChatUnread = 0,
  onOpenAdminChat,
  onInvite,
  onAdminUsers,
  onAvatarChange,
  onLogout,
  onClose,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [localHasAvatar, setLocalHasAvatar] = useState(hasAvatar);
  const [localUpdatedAt, setLocalUpdatedAt] = useState<number | null>(avatarUpdatedAt ?? null);
  const [localAvatarUrl, setLocalAvatarUrl] = useState<string | null>(avatarUrl ?? null);

  useEffect(() => {
    setLocalHasAvatar(hasAvatar);
    setLocalUpdatedAt(avatarUpdatedAt ?? null);
    setLocalAvatarUrl(avatarUrl ?? null);
  }, [hasAvatar, avatarUpdatedAt, avatarUrl]);

  const applyAvatar = (next: {
    hasAvatar: boolean;
    avatarUpdatedAt: number | null;
    avatarUrl: string | null;
  }) => {
    setLocalHasAvatar(next.hasAvatar);
    setLocalUpdatedAt(next.avatarUpdatedAt);
    setLocalAvatarUrl(next.avatarUrl);
    invalidateAvatarCache(userId);
    onAvatarChange?.(next);
  };

  const pickFile = () => {
    if (busy) return;
    inputRef.current?.click();
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const blob = await prepareAvatarFile(file);
      const result = await api.uploadAvatar(blob, 'image/jpeg');
      applyAvatar({
        hasAvatar: true,
        avatarUpdatedAt: result.avatarUpdatedAt,
        avatarUrl: result.avatarUrl ?? null,
      });
      notify.success('Аватар обновлён');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Не удалось загрузить аватар';
      setError(message);
      notify.error(message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const removeAvatar = async () => {
    if (busy || !localHasAvatar) return;
    setBusy(true);
    setError('');
    try {
      await api.deleteAvatar();
      applyAvatar({ hasAvatar: false, avatarUpdatedAt: null, avatarUrl: null });
      notify.success('Аватар удалён');
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Не удалось удалить аватар';
      setError(message);
      notify.error(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Настройки</h2>
        <p className="modal-subtitle">@{username}</p>

        <div className="settings-avatar-block">
          <UserAvatar
            userId={userId}
            name={username}
            hasAvatar={localHasAvatar}
            avatarUpdatedAt={localUpdatedAt}
            avatarUrl={localAvatarUrl}
            className="settings-avatar"
          />
          <div className="settings-avatar-actions">
            <button type="button" className="settings-avatar-btn" onClick={pickFile} disabled={busy}>
              {busy ? 'Загрузка...' : localHasAvatar ? 'Сменить фото' : 'Установить фото'}
            </button>
            {localHasAvatar && (
              <button
                type="button"
                className="settings-avatar-btn settings-avatar-btn-muted"
                onClick={() => void removeAvatar()}
                disabled={busy}
              >
                Удалить
              </button>
            )}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/*"
            hidden
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
        </div>

        {error && <Notice variant="error">{error}</Notice>}

        <ul className="settings-list">
          {!isAdmin && onOpenAdminChat && (
            <li>
              <button type="button" className="settings-item" onClick={onOpenAdminChat}>
                <span className="settings-item-label">Чат с админом</span>
                {adminChatUnread > 0 && (
                  <span className="unread-badge" aria-label={`${adminChatUnread} непрочитанных`}>
                    {adminChatUnread > 99 ? '99+' : adminChatUnread}
                  </span>
                )}
              </button>
            </li>
          )}
          {onInvite && (
            <li>
              <button type="button" className="settings-item" onClick={onInvite}>
                Пригласить друга
              </button>
            </li>
          )}
          {onAdminUsers && (
            <li>
              <button type="button" className="settings-item" onClick={onAdminUsers}>
                Пользователи
              </button>
            </li>
          )}
          <li>
            <button
              type="button"
              className="settings-item settings-item-danger"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onLogout();
              }}
            >
              Выйти
            </button>
          </li>
        </ul>

        <div className="modal-actions settings-footer">
          <span className="settings-version">Версия {APP_VERSION}</span>
          <button type="button" className="link-btn" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
