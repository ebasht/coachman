import { useState, useEffect, useRef } from 'react';
import type { LocalAccount } from '../lib/storage';
import { api } from '../lib/api';
import { onEnablePushClick } from '../lib/push-subscribe';
import { parseAuthLink, type AuthLink } from '../lib/invite-link';
import { decodeQrFromFile } from '../lib/qr-decode';
import { chatInitials } from '../lib/chat-format';
import { Notice } from './Notice';
import { QrScanner } from './QrScanner';

const GITHUB_REPO = 'https://github.com/ebasht/coachman';

const FEATURES = [
  {
    title: 'Личные и групповые чаты',
    text: 'Обмен сообщениями в реальном времени для личного общения, семьи, друзей и небольших команд.',
  },
  {
    title: 'Общие списки',
    text: 'Создавайте списки дел и покупок прямо в чате. Все изменения синхронизируются между участниками.',
  },
  {
    title: 'Видеозвонки',
    text: 'Звонки один на один без подключения сторонних платформ.',
  },
  {
    title: 'Push-уведомления',
    text: 'Получайте уведомления о новых сообщениях и входящих звонках на телефоне или компьютере.',
  },
  {
    title: 'Установка как приложение',
    text: 'Ямщик работает как PWA: устанавливается из браузера и запускается как обычное приложение. Без App Store и Google Play.',
  },
] as const;

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
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [bootstrapUsername, setBootstrapUsername] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bootstrapLocalLoginRef = useRef(false);

  useEffect(() => {
    if (inviteToken) setScannedInviteToken(inviteToken);
  }, [inviteToken]);

  const activeInviteToken = scannedInviteToken;
  const bootstrapToken = bootstrapFromUrl ?? pastedBootstrapToken;
  const isBootstrapFlow = !!bootstrapToken;
  const isInviteSignup = !!activeInviteToken && !isBootstrapFlow;
  const hasAccounts = localAccounts.length > 0;
  const showLinkForm = isInviteSignup || !hasAccounts || showAddAccount;
  const showLanding = !isInviteSignup && !isBootstrapFlow;

  useEffect(() => {
    api
      .getSetupStatus()
      .then((s) => setNeedsBootstrap(!!s.needsBootstrap))
      .catch(() => {})
      .finally(() => setSetupLoaded(true));
  }, []);

  // If this device already has the admin account, bootstrap link just signs in (keep keys).
  useEffect(() => {
    if (!bootstrapToken || !setupLoaded || bootstrapLocalLoginRef.current) return;
    if (needsBootstrap) return;
    const localAdmin = localAccounts.find((a) => a.isAdmin || a.username === 'admin');
    if (!localAdmin) return;
    bootstrapLocalLoginRef.current = true;
    setBootstrapBusy(true);
    onEnablePushClick();
    onLoginLocal(localAdmin.userId);
  }, [bootstrapToken, setupLoaded, needsBootstrap, localAccounts, onLoginLocal]);

  useEffect(() => {
    if (error && bootstrapBusy) {
      setBootstrapBusy(false);
      bootstrapLocalLoginRef.current = false;
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
      bootstrapLocalLoginRef.current = false;
      setPastedBootstrapToken(link.token);
      return;
    }
    setScannedInviteToken(link.token);
    setShowAddAccount(false);
  };

  const submitBootstrap = () => {
    if (!bootstrapToken) return;
    const name = bootstrapUsername.trim();
    if (!name) return;
    setBootstrapBusy(true);
    onEnablePushClick();
    onRegister(name, usePassphrase ? passphrase : undefined, { bootstrapToken });
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

  const authBody = (
    <>
      {error && <Notice variant="error">{error}</Notice>}

      {hasAccounts && !isInviteSignup && !isBootstrapFlow && !showAddAccount && (
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
                    {account.isAdmin && (
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

      {isBootstrapFlow && setupLoaded ? (
        <>
          <p className="invite-banner">
            {needsBootstrap
              ? 'Первый вход: укажите имя — вы станете администратором'
              : 'Восстановление доступа администратора на этом устройстве'}
          </p>
          {needsBootstrap ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitBootstrap();
              }}
            >
              <input
                type="text"
                placeholder="Ваше имя"
                value={bootstrapUsername}
                onChange={(e) => setBootstrapUsername(e.target.value)}
                autoFocus
                autoComplete="username"
                maxLength={64}
              />
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
                  placeholder="Парольная фраза (мин. 12 символов)"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  autoComplete="new-password"
                  minLength={12}
                />
              )}
              <button type="submit" disabled={!bootstrapUsername.trim() || bootstrapBusy}>
                {bootstrapBusy ? 'Создание…' : 'Создать аккаунт админа'}
              </button>
            </form>
          ) : (
            <>
              <p className="invite-entry-hint">
                Если админ уже есть на сервере, войдите в свой аккаунт и в настройках введите
                bootstrap-токен, чтобы стать админом. Либо привяжите это устройство к текущему
                админу (нужен BOOTSTRAP_ALLOW_REBIND на сервере).
              </p>
              <button
                type="button"
                disabled={bootstrapBusy}
                onClick={() => {
                  setBootstrapBusy(true);
                  onEnablePushClick();
                  // Username ignored on rebind; server rotates the existing admin's device keys.
                  onRegister('admin', undefined, { bootstrapToken });
                }}
              >
                {bootstrapBusy ? 'Вход…' : 'Привязать устройство админа'}
              </button>
              {hasAccounts && (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setPastedBootstrapToken(undefined);
                    const url = new URL(window.location.href);
                    if (url.searchParams.has('bootstrap')) {
                      url.searchParams.delete('bootstrap');
                      window.history.replaceState(null, '', url.pathname + url.search);
                    }
                  }}
                >
                  Войти в другой аккаунт
                </button>
              )}
            </>
          )}
        </>
      ) : isInviteSignup ? (
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
                  placeholder="Парольная фраза (мин. 12 символов)"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  autoComplete="new-password"
                  minLength={12}
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
            autoFocus={!showLanding}
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
    </>
  );

  if (!setupLoaded && (bootstrapToken || inviteToken) && !hasAccounts) {
    return (
      <div className="auth-screen">
        <div className="auth-card auth-card-minimal">
          <img className="app-logo" src="/app-icon-192.png" alt="" width={72} height={72} />
          <h1>Ямщик</h1>
          <p className="subtitle">Загрузка...</p>
        </div>
      </div>
    );
  }

  if (isBootstrapFlow && setupLoaded && bootstrapBusy && !error && !needsBootstrap) {
    return (
      <div className="auth-screen">
        <div className="auth-card auth-card-minimal">
          <img className="app-logo" src="/app-icon-192.png" alt="" width={72} height={72} />
          <h1>Ямщик</h1>
          <p className="subtitle">Вход…</p>
        </div>
      </div>
    );
  }

  if (isBootstrapFlow && setupLoaded) {
    return (
      <div className="auth-screen">
        <div className="auth-card auth-card-minimal">
          <img className="app-logo" src="/app-icon-192.png" alt="" width={72} height={72} />
          <h1>Ямщик</h1>
          <p className="subtitle">Настройка администратора</p>
          {authBody}
        </div>
      </div>
    );
  }

  if (showLanding) {
    return (
      <div className="auth-screen is-landing">
        <div className="landing-page">
          <header className="landing-hero">
            <img
              className="landing-mark"
              src="/app-icon-192.png"
              alt=""
              width={88}
              height={88}
            />
            <p className="landing-brand">Ямщик</p>
            <h1 className="landing-headline">Защищённый мессенджер на вашем сервере</h1>
            <p className="landing-lead">
              Приватные чаты, видеозвонки и совместные списки без зависимости от централизованных
              платформ. Ваши данные хранятся там, где решаете вы.
            </p>
            <div className="landing-cta">
              <a
                className="landing-btn landing-btn-primary"
                href="#landing-open"
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById('landing-open')?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start',
                  });
                }}
              >
                Открыть Ямщик
              </a>
              <a
                className="landing-btn landing-btn-secondary"
                href={GITHUB_REPO}
                target="_blank"
                rel="noopener noreferrer"
              >
                Развернуть свой сервер
              </a>
            </div>
          </header>

          <div id="landing-open" className="landing-auth auth-card">
            <p className="landing-auth-label">
              {showAddAccount
                ? 'Добавить аккаунт'
                : hasAccounts
                  ? 'Выберите аккаунт'
                  : 'Вход по приглашению'}
            </p>
            {authBody}
          </div>

          <section className="landing-section" aria-labelledby="landing-secure-title">
            <h2 id="landing-secure-title">Защищённое общение</h2>
            <p>
              Переписка зашифрована. Содержимое сообщений доступно только участникам разговора.
            </p>
            <p>
              Никакой рекламы, анализа переписки и передачи данных сторонним сервисам.
            </p>
          </section>

          <section className="landing-section" aria-labelledby="landing-features-title">
            <h2 id="landing-features-title">Возможности</h2>
            <div className="landing-feature-list">
              {FEATURES.map((item) => (
                <article key={item.title} className="landing-feature">
                  <h3>{item.title}</h3>
                  <p>{item.text}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="landing-section" aria-labelledby="landing-arch-title">
            <h2 id="landing-arch-title">Децентрализованная архитектура</h2>
            <p>
              Ямщик не привязан к единому центральному серверу. Вы можете развернуть собственный
              экземпляр мессенджера для семьи, друзей или команды и самостоятельно контролировать
              инфраструктуру.
            </p>
            <p className="landing-emphasis">Ваш сервер. Ваши пользователи. Ваши данные.</p>
          </section>

          <section className="landing-section" aria-labelledby="landing-oss-title">
            <h2 id="landing-oss-title">Открытый исходный код</h2>
            <p>
              Проект доступен на GitHub. Код можно изучить, проверить, изменить и развернуть на
              собственной инфраструктуре.
            </p>
            <a
              className="landing-github"
              href={GITHUB_REPO}
              target="_blank"
              rel="noopener noreferrer"
            >
              github.com/ebasht/coachman
            </a>
          </section>

          <section className="landing-section landing-closing" aria-labelledby="landing-closing-title">
            <h2 id="landing-closing-title">Контролируйте не только переписку, но и платформу</h2>
            <p>
              Запустите собственный защищённый мессенджер и пригласите пользователей по ссылке.
            </p>
            <div className="landing-cta">
              <a
                className="landing-btn landing-btn-primary"
                href={GITHUB_REPO}
                target="_blank"
                rel="noopener noreferrer"
              >
                Развернуть Ямщик
              </a>
              <a
                className="landing-btn landing-btn-secondary"
                href={GITHUB_REPO}
                target="_blank"
                rel="noopener noreferrer"
              >
                Посмотреть код
              </a>
            </div>
          </section>
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

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <img className="app-logo" src="/app-icon-192.png" alt="" width={72} height={72} />
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
        {authBody}
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
