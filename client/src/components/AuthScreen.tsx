import { useState, useEffect, useRef } from 'react';
import type { LocalAccount } from '../lib/storage';
import { api } from '../lib/api';
import { onEnablePushClick } from '../lib/push-subscribe';
import { parseInviteToken } from '../lib/invite-link';
import { decodeQrFromFile } from '../lib/qr-decode';
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
  const [reservedUsername, setReservedUsername] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState('');

  const activeInviteToken = inviteToken ?? scannedInviteToken;
  const bootstrapAllowed = !!bootstrapToken && (needsBootstrap || (setupFailed && !hasUsers));
  const canSignup = bootstrapAllowed || !!activeInviteToken;
  const isSignup = canSignup && localAccounts.length === 0;
  const isInviteSignup = isSignup && !!activeInviteToken && !bootstrapAllowed;
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
      .catch(() => setInviteError('Ссылка приглашения недействительна или уже использована'));
  }, [activeInviteToken]);

  const applyInviteToken = (token: string) => {
    setInviteLinkError('');
    setScannedInviteToken(token);
  };

  const applyInviteLink = () => {
    const token = parseInviteToken(inviteLinkInput);
    if (!token) {
      setInviteLinkError('Вставьте ссылку приглашения');
      return;
    }
    applyInviteToken(token);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const signupUsername = bootstrapAllowed ? username.trim() : (reservedUsername ?? '');
    if (isSignup) {
      if (!signupUsername) return;
      onEnablePushClick();
      onRegister(signupUsername, usePassphrase ? passphrase : undefined, {
        inviteToken: activeInviteToken,
        bootstrapToken: bootstrapAllowed ? bootstrapToken : undefined,
      });
      return;
    }
    if (!username.trim()) return;
    onEnablePushClick();
    onLogin(username.trim());
  };

  const confirmRemoveFromDevice = (account: LocalAccount) => {
    if (
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
            onQrImage={(token) => applyInviteToken(token)}
            onQrImageError={setInviteLinkError}
          />
        </div>
        {showScanner && (
          <QrScanner
            onScan={(token) => {
              setShowScanner(false);
              applyInviteToken(token);
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
            onQrImage={(token) => applyInviteToken(token)}
            onQrImageError={setInviteLinkError}
          />
        )}

        {inviterName && (
          <p className="invite-banner">Приглашение от @{inviterName}</p>
        )}
        {isInviteSignup && reservedUsername && (
          <p className="invite-reserved-name">Ваш аккаунт: @{reservedUsername}</p>
        )}
        {inviteError && <Notice variant="error">{inviteError}</Notice>}

        {localAccounts.length > 0 && (
          <div className="local-accounts">
            <p className="local-accounts-title">Аккаунты на этом устройстве</p>
            <ul className="local-accounts-list">
              {localAccounts.map((account) => (
                <li key={account.userId} className="local-account-item">
                  <button type="button" className="account-main" onClick={() => { onEnablePushClick(); onLoginLocal(account.userId); }}>
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

        {localAccounts.length > 0 && isSignup && (
          <p className="divider"><span>или новый аккаунт по ссылке</span></p>
        )}

        {(canSignup || localAccounts.length > 0) && (
          <form onSubmit={handleSubmit}>
            {bootstrapAllowed && (
              <input
                type="text"
                placeholder="Имя пользователя"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus={localAccounts.length === 0 && canSignup}
                autoComplete="username"
              />
            )}
            {!isSignup && (
              <input
                type="text"
                placeholder="Имя пользователя"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus={localAccounts.length > 0}
                autoComplete="username"
              />
            )}
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
            <button
              type="submit"
              disabled={!!activeInviteToken && (!!inviteError || (isInviteSignup && !reservedUsername))}
            >
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
            applyInviteToken(token);
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
  onQrImage,
  onQrImageError,
}: {
  inviteLinkInput: string;
  inviteLinkError: string;
  onInviteLinkInputChange: (value: string) => void;
  onApplyInviteLink: () => void;
  onOpenScanner: () => void;
  onQrImage: (token: string) => void;
  onQrImageError: (message: string) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imageLoading, setImageLoading] = useState(false);

  const handleQrImageFile = async (file: File | null | undefined) => {
    if (!file) return;
    setImageLoading(true);
    onQrImageError('');
    try {
      const raw = await decodeQrFromFile(file);
      if (!raw) {
        onQrImageError('QR-код на изображении не найден');
        return;
      }
      const token = parseInviteToken(raw);
      if (!token) {
        onQrImageError('На изображении нет ссылки приглашения');
        return;
      }
      onQrImage(token);
    } catch {
      onQrImageError('Не удалось прочитать изображение');
    } finally {
      setImageLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
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
      <p className="invite-entry-title">Нужно приглашение</p>
      <p className="invite-entry-hint">Сканируйте QR, загрузите фото или вставьте ссылку</p>
      <button type="button" className="qr-scan-btn" onClick={onOpenScanner}>
        Сканировать QR-код
      </button>
      <button
        type="button"
        className="qr-scan-btn"
        disabled={imageLoading}
        onClick={() => fileInputRef.current?.click()}
      >
        {imageLoading ? 'Чтение…' : 'Загрузить фото QR'}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => void handleQrImageFile(e.target.files?.[0])}
      />
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
