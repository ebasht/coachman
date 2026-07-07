import { useState, useEffect } from 'react';
import type { LocalAccount } from '../lib/storage';
import { api } from '../lib/api';
import { parseInviteToken } from '../lib/invite-link';
import { isStandalonePWA } from '../lib/pwa';
import { Notice } from './Notice';
import { QrScanner } from './QrScanner';

interface Props {
  localAccounts: LocalAccount[];
  inviteToken?: string;
  bootstrapToken?: string;
  onRegister: (username: string, passphrase?: string, opts?: { inviteToken?: string; bootstrapToken?: string }) => void;
  onLogin: (username: string) => void;
  onLoginLocal: (userId: string) => void;
  onRemoveFromDevice: (userId: string) => void;
  onDeleteFully: (userId: string) => void;
  error: string;
}

export function AuthScreen({
  localAccounts,
  inviteToken,
  bootstrapToken,
  onRegister,
  onLogin,
  onLoginLocal,
  onRemoveFromDevice,
  onDeleteFully,
  error,
}: Props) {
  const [username, setUsername] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [usePassphrase, setUsePassphrase] = useState(false);
  const [menuUserId, setMenuUserId] = useState<string | null>(null);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [hasUsers, setHasUsers] = useState(false);
  const [setupLoaded, setSetupLoaded] = useState(false);
  const [setupFailed, setSetupFailed] = useState(false);
  const [scannedInviteToken, setScannedInviteToken] = useState<string | undefined>();
  const [inviteLinkInput, setInviteLinkInput] = useState('');
  const [inviteLinkError, setInviteLinkError] = useState('');
  const [showScanner, setShowScanner] = useState(false);
  const [inviterName, setInviterName] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState('');

  const activeInviteToken = inviteToken ?? scannedInviteToken;
  const bootstrapAllowed = !!bootstrapToken && (needsBootstrap || (setupFailed && !hasUsers));
  const canSignup = bootstrapAllowed || !!activeInviteToken;
  const isSignup = canSignup && localAccounts.length === 0;
  const standalone = isStandalonePWA();
  const needsInviteEntry = localAccounts.length === 0 && !canSignup;

  useEffect(() => {
    api.getSetupStatus()
      .then((s) => {
        setNeedsBootstrap(s.needsBootstrap);
        setHasUsers(s.hasUsers);
      })
      .catch(() => setSetupFailed(true))
      .finally(() => setSetupLoaded(true));
  }, []);

  useEffect(() => {
    if (!activeInviteToken) {
      setInviterName(null);
      setInviteError('');
      return;
    }
    setInviteError('');
    api.validateInvite(activeInviteToken)
      .then((info) => setInviterName(info.inviterUsername))
      .catch(() => setInviteError('Ссылка приглашения недействительна или уже использована'));
  }, [activeInviteToken]);

  const applyInviteLink = () => {
    const token = parseInviteToken(inviteLinkInput);
    if (!token) {
      setInviteLinkError('Вставьте ссылку приглашения или QR-код с ней');
      return;
    }
    setInviteLinkError('');
    setScannedInviteToken(token);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) return;
    if (isSignup) {
      onRegister(username.trim(), usePassphrase ? passphrase : undefined, {
        inviteToken: activeInviteToken,
        bootstrapToken: bootstrapAllowed ? bootstrapToken : undefined,
      });
    } else {
      onLogin(username.trim());
    }
  };

  const confirmDelete = (account: LocalAccount, full: boolean) => {
    if (full) {
      if (window.confirm(`Удалить @${account.username} с сервера и с устройства?`)) {
        onDeleteFully(account.userId);
      }
    } else if (
      window.confirm(
        `Убрать @${account.username} только с этого устройства?\n\nАккаунт останется на сервере.`,
      )
    ) {
      onRemoveFromDevice(account.userId);
    }
    setMenuUserId(null);
  };

  if (!setupLoaded && (bootstrapToken || inviteToken) && localAccounts.length === 0) {
    return (
      <div className="auth-screen">
        <div className="auth-card auth-card-minimal">
          <h1>Ямщик</h1>
          <p className="subtitle">Загрузка...</p>
        </div>
      </div>
    );
  }

  if (bootstrapToken && setupLoaded && !needsBootstrap && localAccounts.length === 0 && !activeInviteToken) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h1>Ямщик</h1>
          <p className="subtitle">Вход</p>
          <Notice variant="warning">
            Сервер уже настроен. Bootstrap-ссылка больше не действует — войдите в существующий аккаунт
            или попросите приглашение у администратора.
          </Notice>
          <InviteEntry
            inviteLinkInput={inviteLinkInput}
            inviteLinkError={inviteLinkError}
            onInviteLinkInputChange={setInviteLinkInput}
            onApplyInviteLink={applyInviteLink}
            onOpenScanner={() => setShowScanner(true)}
          />
        </div>
        {showScanner && (
          <QrScanner
            onScan={(token) => {
              setShowScanner(false);
              setScannedInviteToken(token);
            }}
            onClose={() => setShowScanner(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h1>Ямщик</h1>
        <p className="subtitle">
          {bootstrapAllowed ? 'Создание администратора' : isSignup ? 'Регистрация по приглашению' : 'Вход'}
        </p>

        {standalone && localAccounts.length === 0 && (
          <Notice variant="info">
            Войдите или зарегистрируйтесь в этом приложении. Ярлык на экране не видит аккаунты, созданные в Safari.
          </Notice>
        )}

        {bootstrapToken && hasUsers && !needsBootstrap && (
          <Notice variant="warning">
            Сервер уже настроен. Bootstrap-ссылка больше не действует — войдите в аккаунт или используйте приглашение.
          </Notice>
        )}

        {needsInviteEntry && (
          <InviteEntry
            inviteLinkInput={inviteLinkInput}
            inviteLinkError={inviteLinkError}
            onInviteLinkInputChange={setInviteLinkInput}
            onApplyInviteLink={applyInviteLink}
            onOpenScanner={() => setShowScanner(true)}
          />
        )}

        {inviterName && (
          <p className="invite-banner">Приглашение от @{inviterName}</p>
        )}
        {inviteError && <Notice variant="error">{inviteError}</Notice>}

        {localAccounts.length > 0 && (
          <div className="local-accounts">
            <p className="local-accounts-title">Аккаунты на этом устройстве</p>
            <ul className="local-accounts-list">
              {localAccounts.map((account) => (
                <li key={account.userId} className="local-account-item">
                  <button type="button" className="account-main" onClick={() => onLoginLocal(account.userId)}>
                    <span className="account-avatar">{account.username[0]?.toUpperCase()}</span>
                    <span className="account-name">@{account.username}</span>
                  </button>
                  <button
                    type="button"
                    className="account-menu-btn"
                    onClick={() => setMenuUserId(menuUserId === account.userId ? null : account.userId)}
                    title="Управление аккаунтом"
                  >
                    ⋯
                  </button>
                  {menuUserId === account.userId && (
                    <div className="account-menu">
                      <button type="button" onClick={() => confirmDelete(account, false)}>
                        Убрать с устройства
                      </button>
                      <button type="button" className="danger" onClick={() => confirmDelete(account, true)}>
                        Удалить с сервера
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {localAccounts.length > 0 && isSignup && (
          <p className="divider"><span>или новый аккаунт по ссылке</span></p>
        )}

        {(canSignup || localAccounts.length > 0) && (
          <form onSubmit={handleSubmit}>
            <input
              type="text"
              placeholder="Имя пользователя"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus={localAccounts.length === 0 && canSignup}
              autoComplete="username"
            />
            {error && <Notice variant="error">{error}</Notice>}
            {isSignup && (
              <label className="passphrase-option">
                <input
                  type="checkbox"
                  checked={usePassphrase}
                  onChange={(e) => setUsePassphrase(e.target.checked)}
                />
                Защитить парольной фразой
              </label>
            )}
            {isSignup && usePassphrase && (
              <input
                type="password"
                placeholder="Парольная фраза (мин. 6 символов)"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoComplete="new-password"
              />
            )}
            <button type="submit" disabled={!!activeInviteToken && !!inviteError}>
              {isSignup ? 'Создать аккаунт' : 'Войти'}
            </button>
          </form>
        )}

        {canSignup && (
          <p className="hint">
            🔒 Сообщения шифруются на устройстве. Вход только для участников вашего круга.
          </p>
        )}
      </div>

      {showScanner && (
        <QrScanner
          onScan={(token) => {
            setShowScanner(false);
            setScannedInviteToken(token);
          }}
          onClose={() => setShowScanner(false)}
        />
      )}
    </div>
  );
}

function InviteEntry({
  inviteLinkInput,
  inviteLinkError,
  onInviteLinkInputChange,
  onApplyInviteLink,
  onOpenScanner,
}: {
  inviteLinkInput: string;
  inviteLinkError: string;
  onInviteLinkInputChange: (value: string) => void;
  onApplyInviteLink: () => void;
  onOpenScanner: () => void;
}) {
  return (
    <div className="invite-entry">
      <p className="invite-entry-title">Нужно приглашение</p>
      <button type="button" className="qr-scan-btn" onClick={onOpenScanner}>
        Сканировать QR-код
      </button>
      <p className="divider"><span>или</span></p>
      <input
        type="text"
        placeholder="Вставьте ссылку приглашения"
        value={inviteLinkInput}
        onChange={(e) => onInviteLinkInputChange(e.target.value)}
        autoComplete="off"
      />
      {inviteLinkError && <Notice variant="error">{inviteLinkError}</Notice>}
      <button type="button" className="invite-apply-btn" onClick={onApplyInviteLink}>
        Продолжить
      </button>
    </div>
  );
}
