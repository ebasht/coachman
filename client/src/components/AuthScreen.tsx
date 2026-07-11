import { useState, useEffect, useRef, useCallback } from 'react';
import type { LocalAccount } from '../lib/storage';
import { api } from '../lib/api';
import { onEnablePushClick } from '../lib/push-subscribe';
import { parseAuthLink, type AuthLink } from '../lib/invite-link';
import { decodeQrFromFile } from '../lib/qr-decode';
import { chatInitials } from '../lib/chat-format';
import { Notice } from './Notice';
import { QrScanner } from './QrScanner';

interface Props {
  localAccounts: LocalAccount[];
  inviteToken?: string;
  bootstrapToken?: string;
  onRegister: (username: string, passphrase?: string, opts?: { inviteToken?: string; bootstrapToken?: string }) => void;
  onLoginLocal: (userId: string) => void;
  onRemoveFromDevice: (userId: string) => void;
  error: string;
}

export function AuthScreen({
  localAccounts,
  inviteToken,
  bootstrapToken: bootstrapFromUrl,
  onRegister,
  onLoginLocal,
  onRemoveFromDevice,
  error,
}: Props) {
  const [passphrase, setPassphrase] = useState('');
  const [usePassphrase, setUsePassphrase] = useState(false);
  const [menuUserId, setMenuUserId] = useState<string | null>(null);
  const [setupLoaded, setSetupLoaded] = useState(false);
  const [scannedInviteToken, setScannedInviteToken] = useState<string | undefined>(inviteToken);
  const [pastedBootstrapToken, setPastedBootstrapToken] = useState<string | undefined>();
  const [linkInput, setLinkInput] = useState('');
  const [linkError, setLinkError] = useState('');
  const [showScanner, setShowScanner] = useState(false);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [inviterName, setInviterName] = useState<string | null>(null);
  const [reservedUsername, setReservedUsername] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState('');
  const [bootstrapBusy, setBootstrapBusy] = useState(false);
  const bootstrapOnceRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inviteToken) setScannedInviteToken(inviteToken);
  }, [inviteToken]);

  const activeInviteToken = scannedInviteToken;
  const bootstrapToken = bootstrapFromUrl ?? pastedBootstrapToken;
  const isBootstrapFlow = !!bootstrapToken;
  const isInviteSignup = !!activeInviteToken && !isBootstrapFlow;
  const hasAccounts = localAccounts.length > 0;
  const showLinkForm = isInviteSignup || !hasAccounts || showAddAccount;

  const enterAsAdmin = useCallback(
    (token: string) => {
      setBootstrapBusy(true);
      onEnablePushClick();
      // Same device: keep existing keys so old messages stay readable.
      const localAdmin = localAccounts.find((a) => a.isAdmin || a.username === 'admin');
      if (localAdmin) {
        onLoginLocal(localAdmin.userId);
        return;
      }
      onRegister('admin', undefined, { bootstrapToken: token });
    },
    [onRegister, onLoginLocal, localAccounts],
  );

  useEffect(() => {
    api.getSetupStatus()
      .catch(() => {})
      .finally(() => setSetupLoaded(true));
  }, []);

  useEffect(() => {
    if (!bootstrapToken || !setupLoaded || bootstrapOnceRef.current) return;
    bootstrapOnceRef.current = true;
    enterAsAdmin(bootstrapToken);
  }, [bootstrapToken, setupLoaded, enterAsAdmin]);

  useEffect(() => {
    if (error && bootstrapBusy) {
      setBootstrapBusy(false);
      bootstrapOnceRef.current = false;
    }
  }, [error, bootstrapBusy]);

  useEffect(() => {
    if (!activeInviteToken) {
      setInviterName(null);
      setReservedUsername(null);
      setInviteError('');
      return;
    }
    setInviteError('');
    api.validateInvite(activeInviteToken)
      .then((info) => {
        setInviterName(info.inviterUsername);
        setReservedUsername(info.reservedUsername || null);
      })
      .catch(() => setInviteError('Ссылка недействительна или уже использована'));
  }, [activeInviteToken]);

  const applyAuthLink = (link: AuthLink) => {
    setLinkError('');
    if (link.type === 'bootstrap') {
      bootstrapOnceRef.current = false;
      setPastedBootstrapToken(link.token);
      return;
    }
    setScannedInviteToken(link.token);
    setShowAddAccount(false);
  };

  const applyLink = () => {
    const link = parseAuthLink(linkInput);
    if (!link) {
      setLinkError('Вставьте ссылку приглашения');
      return;
    }
    applyAuthLink(link);
  };

  const clearInvite = () => {
    setScannedInviteToken(undefined);
    setLinkInput('');
    setInviterName(null);
    setReservedUsername(null);
    setInviteError('');
    setUsePassphrase(false);
    setPassphrase('');
    const url = new URL(window.location.href);
    if (url.searchParams.has('invite')) {
      url.searchParams.delete('invite');
      window.history.replaceState(null, '', url.pathname + url.search);
    }
  };

  const handleQrImageFile = async (file: File | null | undefined) => {
    if (!file) return;
    setLinkError('');
    try {
      const raw = await decodeQrFromFile(file);
      if (!raw) {
        setLinkError('QR-код на изображении не найден');
        return;
      }
      const link = parseAuthLink(raw);
      if (!link) {
        setLinkError('В QR-коде нет ссылки приглашения');
        return;
      }
      applyAuthLink(link);
    } catch {
      setLinkError('Не удалось прочитать изображение');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const confirmRemoveFromDevice = (account: LocalAccount) => {
    if (
      window.confirm(
        `Убрать ${account.username} только с этого устройства?\n\nАккаунт останется на сервере.`,
      )
    ) {
      onRemoveFromDevice(account.userId);
    }
    setMenuUserId(null);
  };

  if (!setupLoaded && (bootstrapToken || inviteToken) && !hasAccounts) {
    return (
      <div className="auth-screen">
        <div className="auth-card auth-card-minimal">
        <img className="app-logo" src="/icon-192.png" alt="" width={72} height={72} />
          <h1>Ямщик</h1>
          <p className="subtitle">Загрузка...</p>
        </div>
      </div>
    );
  }

  if (isBootstrapFlow && setupLoaded && bootstrapBusy && !error) {
    return (
      <div className="auth-screen">
        <div className="auth-card auth-card-minimal">
        <img className="app-logo" src="/icon-192.png" alt="" width={72} height={72} />
          <h1>Ямщик</h1>
          <p className="subtitle">Вход…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <img className="app-logo" src="/icon-192.png" alt="" width={72} height={72} />
        <h1>Ямщик</h1>
        <p className="subtitle">
          {isInviteSignup
            ? 'Новый аккаунт'
            : showAddAccount
              ? 'Добавить аккаунт'
              : hasAccounts
                ? 'Выберите аккаунт'
                : 'Вход по ссылке'}
        </p>

        {error && <Notice variant="error">{error}</Notice>}

        {hasAccounts && !isInviteSignup && !showAddAccount && (
          <div className="local-accounts">
            <ul className="local-accounts-list">
              {localAccounts.map((account) => (
                <li key={account.userId} className="local-account-item">
                  <button
                    type="button"
                    className="account-main"
                    onClick={() => {
                      onEnablePushClick();
                      onLoginLocal(account.userId);
                    }}
                  >
                    <span className="account-avatar">{chatInitials(account.username)}</span>
                    <span className="account-name">
                      {account.username}
                      {(account.isAdmin || account.username === 'admin') && (
                        <span className="account-admin-badge"> админ</span>
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="account-menu-btn"
                    onClick={() => setMenuUserId(menuUserId === account.userId ? null : account.userId)}
                    title="Ещё"
                  >
                    ⋯
                  </button>
                  {menuUserId === account.userId && (
                    <div className="account-menu">
                      <button type="button" onClick={() => confirmRemoveFromDevice(account)}>
                        Убрать с устройства
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {isInviteSignup ? (
          <>
            {inviterName && (
              <p className="invite-banner">Вас пригласил {inviterName}</p>
            )}
            {reservedUsername && (
              <p className="invite-reserved-name">{reservedUsername}</p>
            )}
            {inviteError && <Notice variant="error">{inviteError}</Notice>}
            {!inviteError && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!reservedUsername || !activeInviteToken) return;
                  onEnablePushClick();
                  onRegister(reservedUsername, usePassphrase ? passphrase : undefined, {
                    inviteToken: activeInviteToken,
                  });
                }}
              >
                <label className="passphrase-option">
                  <input
                    type="checkbox"
                    checked={usePassphrase}
                    onChange={(e) => setUsePassphrase(e.target.checked)}
                  />
                  Защитить парольной фразой
                </label>
                {usePassphrase && (
                  <input
                    type="password"
                    placeholder="Парольная фраза"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    autoComplete="new-password"
                  />
                )}
                <button type="submit" disabled={!reservedUsername}>
                  Войти
                </button>
              </form>
            )}
            <button type="button" className="link-btn" onClick={clearInvite}>
              Назад
            </button>
          </>
        ) : showLinkForm ? (
          <div
            className="invite-entry"
            onPaste={(e) => {
              const file = Array.from(e.clipboardData.items)
                .find((item) => item.type.startsWith('image/'))
                ?.getAsFile();
              if (!file) return;
              e.preventDefault();
              void handleQrImageFile(file);
            }}
          >
            <p className="invite-entry-hint">Вставьте ссылку приглашения</p>
            <input
              type="text"
              placeholder="Ссылка приглашения"
              value={linkInput}
              onChange={(e) => {
                setLinkInput(e.target.value);
                setLinkError('');
              }}
              autoFocus
              autoComplete="off"
            />
            {linkError && <Notice variant="error">{linkError}</Notice>}
            <button type="button" className="invite-apply-btn" onClick={applyLink}>
              Продолжить
            </button>
            <div className="auth-secondary-actions">
              <button type="button" className="link-btn" onClick={() => setShowScanner(true)}>
                Сканировать QR
              </button>
              <button type="button" className="link-btn" onClick={() => fileInputRef.current?.click()}>
                Фото QR
              </button>
              {hasAccounts && (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setShowAddAccount(false);
                    setLinkInput('');
                    setLinkError('');
                  }}
                >
                  Назад
                </button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => void handleQrImageFile(e.target.files?.[0])}
            />
          </div>
        ) : (
          <button
            type="button"
            className="link-btn auth-add-account"
            onClick={() => setShowAddAccount(true)}
          >
            Добавить аккаунт по ссылке
          </button>
        )}
      </div>

      {showScanner && (
        <QrScanner
          onScan={(raw) => {
            setShowScanner(false);
            const link = parseAuthLink(raw);
            if (link) applyAuthLink(link);
            else setLinkError('В QR-коде нет ссылки приглашения');
          }}
          onClose={() => setShowScanner(false)}
        />
      )}
    </div>
  );
}
