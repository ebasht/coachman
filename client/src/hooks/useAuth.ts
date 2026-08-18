import { useState, useEffect, useCallback } from 'react';
import {
  generateKeyPair,
  generateSigningKeyPair,
  exportPublicKey,
  exportPrivateKey,
  exportSigningPublicKey,
  exportSigningPrivateKey,
  importPrivateKey,
  importSigningPrivateKey,
  signNonce,
} from '../lib/crypto';
import {
  saveLocalAccount,
  getLocalAccounts,
  getLocalAccountByUserId,
  getLocalAccountByUsername,
  saveLastActiveUserId,
  loadLastActiveUserId,
  migrateLegacyKeys,
  clearSession,
  purgeLegacyUnscopedGroupKeys,
  removeLocalAccount,
  type LocalAccount,
} from '../lib/storage';
import { api, setAuthToken, setAuthTokenLoader, setAuthRefresher, getAuthToken } from '../lib/api';
import { encryptSecret, decryptSecret } from '../lib/key-storage';
import { clearSessionToken, loadLastUserId, loadSessionToken, saveSessionToken } from '../lib/auth-persistence';
import { requestPersistentStorage } from '../lib/pwa';
import { probeServerReachable } from '../lib/reachability';
import { notify } from '../lib/notify';
import {
  encryptKeyBackupForAdmin,
  unwrapRecoveryBundle,
  type RecoveryKeyBundle,
} from '../lib/login-recovery';
import { hasLocalBootstrapKeys, pickBootstrapLocalAccount } from '../lib/bootstrap-local';
import {
  restoreAdminFromBackup,
  uploadAdminKeyBackup,
  tryUploadAdminKeyBackup,
  clearRememberedBootstrapToken,
  rememberBootstrapToken,
  hydrateGroupKeysFromBackup,
} from '../lib/admin-key-backup';

function isUnauthorizedError(err: unknown) {
  return err instanceof Error && /unauthorized|401/i.test(err.message);
}

function normalizeUsername(username: string) {
  const normalized = username.trim().replace(/\s+/g, ' ');
  return Array.from(normalized).slice(0, 64).join('');
}

export interface AuthState {
  userId: string;
  username: string;
  publicKey: string;
  privateKey: CryptoKey;
  token: string;
  isAdmin: boolean;
  hasAvatar: boolean;
  avatarUpdatedAt: number | null;
  avatarUrl: string | null;
}

async function bindSigningKey(account: LocalAccount, signingPublicKey: string): Promise<void> {
  await api.attachSigning(account.username, account.publicKey, signingPublicKey);
}

function mapAuthError(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : '';
  if (/Admin key backup exists|admin key backup exists/i.test(msg)) {
    return 'На сервере есть резервная копия ключей. Откройте bootstrap-ссылку для восстановления без смены ключей.';
  }
  if (/signing key already set|Signing key already set/i.test(msg)) {
    return 'Ключ входа на сервере уже привязан к другому устройству. Для смены устройства админа включите BOOTSTRAP_ALLOW_REBIND=1 и откройте bootstrap-ссылку.';
  }
  if (/invalid signature/i.test(msg)) return 'Ошибка проверки ключа. Попробуйте войти ещё раз.';
  if (/invalid or expired challenge/i.test(msg)) return 'Сессия входа истекла. Попробуйте ещё раз.';
  if (/signing key not configured/i.test(msg)) return 'Ключ входа не настроен. Попробуйте войти ещё раз.';
  if (/user not found/i.test(msg)) return 'Пользователь не найден на сервере.';
  if (/unauthorized/i.test(msg)) return 'Не удалось войти. Выберите аккаунт из списка или перезапустите сервер.';
  if (/internal error/i.test(msg)) return 'Ошибка сервера. Перезапустите npm run dev и попробуйте снова.';
  return msg || fallback;
}

async function verifyWithRetry(current: LocalAccount) {
  const tryVerify = async () => {
    const { nonce } = await api.challenge(current.username);
    const signingKey = await importSigningPrivateKey(current.signingPrivateKey!);
    const signature = await signNonce(signingKey, nonce);
    return api.verify(current.username, signature);
  };

  try {
    return await tryVerify();
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (
      current.signingPublicKey &&
      (/invalid signature/i.test(msg) ||
        /unauthorized/i.test(msg) ||
        /signing key not configured/i.test(msg))
    ) {
      await bindSigningKey(current, current.signingPublicKey);
      return tryVerify();
    }
    throw e;
  }
}

async function authenticateAccount(account: LocalAccount): Promise<{
  user: LocalAccount;
  token: string;
  isAdmin: boolean;
  hasAvatar: boolean;
  avatarUpdatedAt: number | null;
  avatarUrl: string | null;
}> {
  let current = { ...account };

  if (!current.privateKey) {
    throw new Error('Аккаунт заблокирован');
  }

  if (!current.signingPrivateKey || !current.signingPublicKey) {
    const signingPair = await generateSigningKeyPair();
    const signingPublicKey = await exportSigningPublicKey(signingPair.publicKey);
    const signingPrivateKey = await exportSigningPrivateKey(signingPair.privateKey);
    await bindSigningKey(current, signingPublicKey);
    current = { ...current, signingPublicKey, signingPrivateKey };
    await saveLocalAccount(current);
  }

  const result = await verifyWithRetry(current);
  const token = result.token;
  const user = result.user;
  const isAdmin = !!user.isAdmin;

  setAuthToken(token);
  const updated: LocalAccount = {
    ...current,
    userId: user.id,
    username: user.username,
    publicKey: user.publicKey,
    isAdmin,
  };
  await saveLocalAccount(updated);
  return {
    user: updated,
    token,
    isAdmin,
    hasAvatar: !!user.hasAvatar,
    avatarUpdatedAt: user.avatarUpdatedAt ?? null,
    avatarUrl: user.avatarUrl ?? null,
  };
}

/** Upload admin-escrowed private keys so the admin can issue a recovery QR later. */
async function syncKeyBackup(account: LocalAccount): Promise<void> {
  if (!account.privateKey || !account.signingPrivateKey || !account.signingPublicKey) return;
  try {
    const { publicKey: adminPub } = await api.getAdminPublicKey();
    const bundle: RecoveryKeyBundle = {
      v: 1,
      privateKey: account.privateKey,
      signingPrivateKey: account.signingPrivateKey,
      signingPublicKey: account.signingPublicKey,
    };
    const ciphertext = await encryptKeyBackupForAdmin(bundle, adminPub);
    await api.putKeyBackup(ciphertext);
  } catch {
    // Escrow is best-effort — recovery QR may be unavailable until next successful sync.
  }
}

export function useAuth() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [lockedAccount, setLockedAccount] = useState<LocalAccount | null>(null);
  const [localAccounts, setLocalAccounts] = useState<LocalAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const showError = useCallback((message: string) => {
    setError(message);
    notify.error(message);
  }, []);

  const refreshLocalAccounts = useCallback(async () => {
    setLocalAccounts(await getLocalAccounts());
  }, []);

  const activateAccount = useCallback(async (
    account: LocalAccount,
    token: string,
    isAdmin = false,
    avatar?: { hasAvatar?: boolean; avatarUpdatedAt?: number | null; avatarUrl?: string | null },
  ) => {
    if (!account.privateKey) throw new Error('Нет ключа');
    // Switching accounts on one device must not keep the previous user's group keys /
    // decrypted message cache — that is what breaks «Общий» for a second login (e.g. admin).
    const prevUserId = await loadLastActiveUserId();
    if (prevUserId && prevUserId !== account.userId) {
      await clearSession();
    } else {
      // Drop pre-multi-account groupKey:<chatId> rows so they cannot bleed into this user.
      await purgeLegacyUnscopedGroupKeys();
    }
    const privateKey = await importPrivateKey(account.privateKey);
    await saveLastActiveUserId(account.userId);
    await saveSessionToken(account.userId, token);
    setAuthToken(token);
    void requestPersistentStorage();
    const admin = isAdmin || !!account.isAdmin;
    if (admin !== !!account.isAdmin) {
      await saveLocalAccount({ ...account, isAdmin: admin });
    }
    setAuth({
      userId: account.userId,
      username: account.username,
      publicKey: account.publicKey,
      privateKey,
      token,
      isAdmin: admin,
      hasAvatar: !!avatar?.hasAvatar,
      avatarUpdatedAt: avatar?.avatarUpdatedAt ?? null,
      avatarUrl: avatar?.avatarUrl ?? null,
    });
  }, []);

  const updateAvatar = useCallback((
    hasAvatar: boolean,
    avatarUpdatedAt: number | null,
    avatarUrl: string | null = null,
  ) => {
    setAuth((prev) => (prev ? { ...prev, hasAvatar, avatarUpdatedAt, avatarUrl } : prev));
  }, []);

  const markAsAdmin = useCallback(async () => {
    setAuth((prev) => (prev ? { ...prev, isAdmin: true } : prev));
    const userId = auth?.userId;
    if (!userId) return;
    const account = await getLocalAccountByUserId(userId);
    if (account) {
      await saveLocalAccount({ ...account, isAdmin: true });
      await refreshLocalAccounts();
    }
  }, [auth?.userId, refreshLocalAccounts]);

  const restoreLocalSession = useCallback(
    async (account: LocalAccount): Promise<boolean> => {
      if (account.encryptedPrivateKey && !account.privateKey) {
        setLockedAccount(account);
        return true;
      }
      if (!account.privateKey) return false;

      const storedToken = (await loadSessionToken(account.userId)) ?? '';

      // If we have a stored token, use offline-first: show UI immediately.
      // If no stored token, we MUST authenticate first to get a valid token.
      if (storedToken) {
        await activateAccount(account, storedToken, !!account.isAdmin);

        // Background validation/refresh
        void (async () => {
          try {
            if (!navigator.onLine) return;
            const reachable = await probeServerReachable(1500);
            if (!reachable) return;

            setAuthToken(storedToken);
            try {
              const me = await api.getMe();
              setAuth((prev) =>
                prev && prev.userId === me.id
                  ? {
                      ...prev,
                      username: me.username,
                      publicKey: me.publicKey || prev.publicKey,
                      isAdmin: !!me.isAdmin,
                      hasAvatar: !!me.hasAvatar,
                      avatarUpdatedAt: me.avatarUpdatedAt ?? null,
                      avatarUrl: me.avatarUrl ?? null,
                    }
                  : prev,
              );
              if (!!me.isAdmin !== !!account.isAdmin) {
                await saveLocalAccount({ ...account, isAdmin: !!me.isAdmin });
              }
              void syncKeyBackup(account);
              return;
            } catch (err) {
              if (!isUnauthorizedError(err) || !account.signingPrivateKey) return;
              // Token expired, re-authenticate
              const { user, token, isAdmin, hasAvatar, avatarUpdatedAt, avatarUrl } =
                await authenticateAccount(account);
              await activateAccount(user, token, isAdmin, {
                hasAvatar,
                avatarUpdatedAt,
                avatarUrl,
              });
              void syncKeyBackup(user);
            }
          } catch {
            // Stay on the local session; API 401 path refreshes via setAuthRefresher.
          }
        })();
      } else if (account.signingPrivateKey) {
        // No stored token - must authenticate first (blocking)
        try {
          const { user, token, isAdmin, hasAvatar, avatarUpdatedAt, avatarUrl } =
            await authenticateAccount(account);
          await activateAccount(user, token, isAdmin, {
            hasAvatar,
            avatarUpdatedAt,
            avatarUrl,
          });
          void syncKeyBackup(user);
        } catch {
          // Auth failed - activate with empty token, user will see errors
          await activateAccount(account, '', !!account.isAdmin);
        }
      } else {
        // No token and no signing key - activate offline
        await activateAccount(account, '', !!account.isAdmin);
      }

      return true;
    },
    [activateAccount],
  );

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        await migrateLegacyKeys();
        if (!active) return;
        await refreshLocalAccounts();
        if (!active) return;

        const lastId = (await loadLastActiveUserId()) ?? (await loadLastUserId()) ?? undefined;
        let account = lastId ? await getLocalAccountByUserId(lastId) : undefined;
        if (!account) {
          const accounts = await getLocalAccounts();
          account = accounts.find((a) => a.privateKey || a.encryptedPrivateKey);
        }

        if (account) {
          await restoreLocalSession(account);
        }
      } catch {
        // IndexedDB errors on cold start — still show the shell / login.
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [refreshLocalAccounts, restoreLocalSession]);

  const loginLocal = async (userId: string) => {
    setError('');
    try {
      const account = await getLocalAccountByUserId(userId);
      if (!account) {
        showError('Аккаунт не найден на устройстве');
        return;
      }
      if (account.encryptedPrivateKey && !account.privateKey) {
        setLockedAccount(account);
        return;
      }
      const { user, token, isAdmin, hasAvatar, avatarUpdatedAt, avatarUrl } = await authenticateAccount(account);
      await activateAccount(user, token, isAdmin, { hasAvatar, avatarUpdatedAt, avatarUrl });
      void syncKeyBackup({ ...account, ...user, isAdmin });
      if (isAdmin && account.privateKey) {
        void tryUploadAdminKeyBackup({ ...account, ...user, isAdmin: true });
      }
    } catch (e) {
      showError(mapAuthError(e, 'Не удалось войти'));
    }
  };

  const register = async (
    username: string,
    passphrase?: string,
    opts?: { inviteToken?: string; bootstrapToken?: string; forceRebind?: boolean }
  ) => {
    setError('');
    const name = normalizeUsername(username);
    if (!name) {
      showError('Введите имя пользователя');
      return;
    }
    if (passphrase && passphrase.length < 12) {
      showError('Парольная фраза — минимум 12 символов');
      return;
    }
    try {
      // Bootstrap restore path: keep the same E2E identity so message history decrypts.
      if (opts?.bootstrapToken && !opts.forceRebind) {
        const existing = pickBootstrapLocalAccount(await getLocalAccounts());
        if (hasLocalBootstrapKeys(existing)) {
          await rememberBootstrapToken(opts.bootstrapToken);
          await hydrateGroupKeysFromBackup(opts.bootstrapToken, existing!.userId);
          return loginLocal(existing!.userId);
        }
        const restored = await restoreAdminFromBackup(opts.bootstrapToken);
        if (restored) {
          await saveLocalAccount(restored);
          await refreshLocalAccounts();
          const { token, hasAvatar, avatarUpdatedAt, avatarUrl, isAdmin } =
            await authenticateAccount(restored);
          await activateAccount(restored, token, isAdmin, {
            hasAvatar,
            avatarUpdatedAt,
            avatarUrl,
          });
          void syncKeyBackup(restored);
          try {
            await uploadAdminKeyBackup(restored, opts.bootstrapToken);
          } catch {
            /* identity already restored */
          }
          return;
        }
      }

      const pair = await generateKeyPair();
      const signingPair = await generateSigningKeyPair();
      const publicKey = await exportPublicKey(pair.publicKey);
      const signingPublicKey = await exportSigningPublicKey(signingPair.publicKey);
      const user = await api.register(name, publicKey, signingPublicKey, {
        inviteToken: opts?.inviteToken,
        bootstrapToken: opts?.bootstrapToken,
        forceRebind: opts?.forceRebind,
      });
      const privB64 = await exportPrivateKey(pair.privateKey);
      const signingPrivB64 = await exportSigningPrivateKey(signingPair.privateKey);

      const account: LocalAccount = passphrase
        ? {
            userId: user.id,
            username: user.username,
            publicKey,
            isAdmin: !!user.isAdmin,
            signingPublicKey,
            encryptedPrivateKey: await encryptSecret(privB64, passphrase),
            encryptedSigningPrivateKey: await encryptSecret(signingPrivB64, passphrase),
          }
        : {
            userId: user.id,
            username: user.username,
            publicKey,
            isAdmin: !!user.isAdmin,
            privateKey: privB64,
            signingPublicKey,
            signingPrivateKey: signingPrivB64,
          };
      await saveLocalAccount(account);
      await refreshLocalAccounts();

      const working: LocalAccount = {
        ...account,
        privateKey: privB64,
        signingPrivateKey: signingPrivB64,
      };
      const { token, hasAvatar, avatarUpdatedAt, avatarUrl } = await authenticateAccount(working);
      await activateAccount(working, token, !!user.isAdmin, {
        hasAvatar: hasAvatar || !!user.hasAvatar,
        avatarUpdatedAt: avatarUpdatedAt ?? user.avatarUpdatedAt ?? null,
        avatarUrl: avatarUrl ?? user.avatarUrl ?? null,
      });
      void syncKeyBackup(working);
      if (opts?.bootstrapToken && user.isAdmin) {
        try {
          await uploadAdminKeyBackup(working, opts.bootstrapToken);
        } catch {
          /* first backup may retry on next login */
        }
        // Group AES keys are created just after first chat sync — refresh backup shortly.
        window.setTimeout(() => {
          void tryUploadAdminKeyBackup({ ...working, isAdmin: true });
        }, 2500);
      }
    } catch (e) {
      showError(mapAuthError(e, 'Ошибка регистрации'));
    }
  };

  const recoverWithLink = async (token: string, keyB64Url: string) => {
    setError('');
    try {
      const session = await api.consumeRecovery(token);
      const bundle = await unwrapRecoveryBundle(session.ciphertext, keyB64Url);
      const account: LocalAccount = {
        userId: session.userId,
        username: session.username,
        publicKey: session.publicKey,
        privateKey: bundle.privateKey,
        signingPublicKey: bundle.signingPublicKey || session.signingPublicKey,
        signingPrivateKey: bundle.signingPrivateKey,
      };
      await saveLocalAccount(account);
      await refreshLocalAccounts();
      const { user, token: jwt, isAdmin, hasAvatar, avatarUpdatedAt, avatarUrl } =
        await authenticateAccount(account);
      await activateAccount(user, jwt, isAdmin, { hasAvatar, avatarUpdatedAt, avatarUrl });
      void syncKeyBackup(user);
      const url = new URL(window.location.href);
      if (url.searchParams.has('recover') || url.searchParams.has('k')) {
        url.searchParams.delete('recover');
        url.searchParams.delete('k');
        window.history.replaceState(null, '', url.pathname + url.search);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (/expired/i.test(msg)) {
        showError('Ссылка восстановления истекла');
      } else if (/invalid recovery/i.test(msg)) {
        showError('Ссылка восстановления недействительна');
      } else if (/decrypt|operation|key|payload/i.test(msg)) {
        showError('Не удалось расшифровать ключи восстановления');
      } else {
        showError(mapAuthError(e, 'Не удалось восстановить вход'));
      }
    }
  };

  const unlock = async (passphrase: string) => {
    setError('');
    if (!lockedAccount) return;
    try {
      const privateKey = await decryptSecret(lockedAccount.encryptedPrivateKey!, passphrase);
      const signingPrivateKey = lockedAccount.encryptedSigningPrivateKey
        ? await decryptSecret(lockedAccount.encryptedSigningPrivateKey, passphrase)
        : undefined;
      const account: LocalAccount = { ...lockedAccount, privateKey, signingPrivateKey };
      const { user, token, isAdmin, hasAvatar, avatarUpdatedAt, avatarUrl } = await authenticateAccount(account);
      setLockedAccount(null);
      await activateAccount(user, token, isAdmin, { hasAvatar, avatarUpdatedAt, avatarUrl });
      void syncKeyBackup(account);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (/decrypt|operation|key/i.test(msg)) {
        showError('Неверная парольная фраза');
      } else {
        showError(mapAuthError(e, 'Не удалось войти'));
      }
    }
  };

  const login = async (username: string) => {
    setError('');
    const name = normalizeUsername(username);
    const local = await getLocalAccountByUsername(name);
    if (local) {
      return loginLocal(local.userId);
    }
    showError('Аккаунт не найден на этом устройстве. Зарегистрируйтесь или выберите из списка.');
  };

  const logout = async () => {
    const userId = auth?.userId ?? (await loadLastActiveUserId());
    await clearSession();
    if (userId) await clearSessionToken(userId);
    setAuthToken(null);
    setAuth(null);
    setError('');
  };

  const removeFromDevice = async (userId: string) => {
    await removeLocalAccount(userId);
    await clearRememberedBootstrapToken();
    await refreshLocalAccounts();
    setError('');
  };

  const refreshSession = useCallback(async (): Promise<boolean> => {
    if (!auth) return false;

    const stored = await loadSessionToken(auth.userId);
    if (stored) setAuthToken(stored);
    else if (auth.token) setAuthToken(auth.token);

    if (!navigator.onLine) {
      return !!(stored || auth.token || getAuthToken());
    }

    try {
      await api.getMe();
      return true;
    } catch (e) {
      if (!isUnauthorizedError(e)) {
        // Offline: keep cached token for the outbox. Online but getMe failed (timeout/5xx):
        // do not return true — that made send retry with the same JWT forever.
        if (!navigator.onLine) {
          return !!(stored || auth.token || getAuthToken());
        }
      }
    }

    let account = await getLocalAccountByUserId(auth.userId);
    if (!account) return false;

    if (!account.privateKey) {
      const { exportPrivateKey } = await import('../lib/crypto');
      account = { ...account, privateKey: await exportPrivateKey(auth.privateKey) };
    }

    try {
      const { user, token, hasAvatar, avatarUpdatedAt, avatarUrl } = await authenticateAccount(account);
      await activateAccount(user, token, undefined, { hasAvatar, avatarUpdatedAt, avatarUrl });
      return true;
    } catch {
      return false;
    }
  }, [auth, activateAccount]);

  useEffect(() => {
    setAuthTokenLoader(async () => {
      if (auth?.token) return auth.token;
      const userId = auth?.userId ?? (await loadLastActiveUserId()) ?? undefined;
      if (!userId) return null;
      return loadSessionToken(userId);
    });
    setAuthRefresher(refreshSession);
    return () => {
      setAuthTokenLoader(null);
      setAuthRefresher(null);
    };
  }, [auth, refreshSession]);

  return {
    auth,
    lockedAccount,
    localAccounts,
    loading,
    error,
    register,
    recoverWithLink,
    login,
    loginLocal,
    unlock,
    logout,
    removeFromDevice,
    refreshSession,
    updateAvatar,
    markAsAdmin,
  };
}
