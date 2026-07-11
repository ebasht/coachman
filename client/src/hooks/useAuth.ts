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
  removeLocalAccount,
  type LocalAccount,
} from '../lib/storage';
import { api, setAuthToken, setAuthTokenLoader, setAuthRefresher, getAuthToken } from '../lib/api';
import { encryptSecret, decryptSecret } from '../lib/key-storage';
import { clearSessionToken, loadLastUserId, loadSessionToken, saveSessionToken } from '../lib/auth-persistence';
import { requestPersistentStorage } from '../lib/pwa';
import { notify } from '../lib/notify';

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
  try {
    await api.attachSigning(account.username, account.publicKey, signingPublicKey);
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('already set') || msg.includes('Signing key already set')) {
      await api.resetSigning(account.username, account.publicKey, signingPublicKey);
      return;
    }
    throw e;
  }
}

function mapAuthError(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : '';
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

  const restoreLocalSession = useCallback(
    async (account: LocalAccount): Promise<boolean> => {
      if (account.encryptedPrivateKey && !account.privateKey) {
        setLockedAccount(account);
        return true;
      }
      if (!account.privateKey) return false;

      const storedToken = (await loadSessionToken(account.userId)) ?? '';

      if (navigator.onLine) {
        try {
          if (storedToken) {
            setAuthToken(storedToken);
            const me = await api.getMe();
            await activateAccount(
              { ...account, userId: me.id, username: me.username, publicKey: me.publicKey, isAdmin: !!me.isAdmin },
              storedToken,
              !!me.isAdmin,
              {
                hasAvatar: me.hasAvatar,
                avatarUpdatedAt: me.avatarUpdatedAt ?? null,
                avatarUrl: me.avatarUrl ?? null,
              },
            );
            return true;
          }
          const { user, token, isAdmin, hasAvatar, avatarUpdatedAt, avatarUrl } = await authenticateAccount(account);
          await activateAccount(user, token, isAdmin, { hasAvatar, avatarUpdatedAt, avatarUrl });
          return true;
        } catch {
          try {
            const { user, token, isAdmin, hasAvatar, avatarUpdatedAt, avatarUrl } = await authenticateAccount(account);
            await activateAccount(user, token, isAdmin, { hasAvatar, avatarUpdatedAt, avatarUrl });
            return true;
          } catch {
            await clearSessionToken(account.userId);
            await clearSession();
            setAuthToken(null);
            setAuth(null);
            return false;
          }
        }
      }

      await activateAccount(account, storedToken, !!account.isAdmin);
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
        // IndexedDB or network errors on cold start — still show the shell
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [refreshLocalAccounts, restoreLocalSession]);

  const register = async (
    username: string,
    passphrase?: string,
    opts?: { inviteToken?: string; bootstrapToken?: string }
  ) => {
    setError('');
    const name = normalizeUsername(username);
    if (!name) {
      showError('Введите имя пользователя');
      return;
    }
    if (passphrase && passphrase.length < 6) {
      showError('Парольная фраза — минимум 6 символов');
      return;
    }
    try {
      const pair = await generateKeyPair();
      const signingPair = await generateSigningKeyPair();
      const publicKey = await exportPublicKey(pair.publicKey);
      const signingPublicKey = await exportSigningPublicKey(signingPair.publicKey);
      const user = await api.register(name, publicKey, signingPublicKey, opts);
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
    } catch (e) {
      showError(mapAuthError(e, 'Ошибка регистрации'));
    }
  };

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
    } catch (e) {
      showError(mapAuthError(e, 'Не удалось войти'));
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
        return !!(stored || auth.token || getAuthToken());
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
    login,
    loginLocal,
    unlock,
    logout,
    removeFromDevice,
    refreshSession,
    updateAvatar,
  };
}
