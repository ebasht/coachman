import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { notify } from '../lib/notify';
import { prepareAvatarFile } from '../lib/prepare-avatar';
import { parseAuthLink } from '../lib/invite-link';
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
  onInvite?: () => void;
  onAdminUsers?: () => void;
  onBecameAdmin?: () => void;
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
  onInvite,
  onAdminUsers,
  onBecameAdmin,
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
  const [showClaimAdmin, setShowClaimAdmin] = useState(false);
  const [bootstrapInput, setBootstrapInput] = useState('');
  const [claimBusy, setClaimBusy] = useState(false);

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

  const claimAdmin = async () => {
    const raw = bootstrapInput.trim();
    if (!raw) return;
    const link = parseAuthLink(raw);
    const token = link?.type === 'bootstrap' ? link.token : raw;
    setClaimBusy(true);
    setError('');
    try {
      await api.claimAdmin(token);
      notify.success('Вы теперь администратор');
      setShowClaimAdmin(false);
      setBootstrapInput('');
      onBecameAdmin?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Не удалось стать админом';
      setError(message);
      notify.error(message);
    } finally {
      setClaimBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Настройки</h2>
        <p className="modal-subtitle">
          {username}
          {isAdmin ? ' · админ' : ''}
        </p>

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
          {!isAdmin && (
            <li>
              <button
                type="button"
                className="settings-item"
                onClick={() => {
                  setShowClaimAdmin((v) => !v);
                  setError('');
                }}
              >
                Стать администратором
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

        {showClaimAdmin && !isAdmin && (
          <div className="settings-claim-admin">
            <p className="invite-entry-hint">
              Вставьте bootstrap-токен или ссылку с сервера (`BOOTSTRAP_TOKEN`). Предыдущий админ
              потеряет права.
            </p>
            <input
              type="text"
              placeholder="Bootstrap-токен или ссылка"
              value={bootstrapInput}
              onChange={(e) => setBootstrapInput(e.target.value)}
              autoComplete="off"
            />
            <button
              type="button"
              disabled={!bootstrapInput.trim() || claimBusy}
              onClick={() => void claimAdmin()}
            >
              {claimBusy ? 'Проверка…' : 'Получить права админа'}
            </button>
          </div>
        )}

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
