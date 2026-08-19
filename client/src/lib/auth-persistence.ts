import { deleteKey, getKey, saveKey } from './storage';

const TOKEN_PREFIX = 'token:';
const LAST_USER_KEY = 'lastUserId';
const LS_LAST_USER_KEY = 'cm:lastUserId';
const LS_TOKEN_PREFIX = 'cm:token:';

let migrated = false;

async function migrateFromLocalStorage() {
  if (migrated) return;
  migrated = true;

  const lsUserId = localStorage.getItem(LS_LAST_USER_KEY);
  if (lsUserId) {
    const idbUserId = await getKey(LAST_USER_KEY);
    if (!idbUserId) {
      await saveKey(LAST_USER_KEY, lsUserId);
    }
    const lsToken = localStorage.getItem(`${LS_TOKEN_PREFIX}${lsUserId}`);
    if (lsToken && !(await getKey(`${TOKEN_PREFIX}${lsUserId}`))) {
      await saveKey(`${TOKEN_PREFIX}${lsUserId}`, lsToken);
    }
  }

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(LS_TOKEN_PREFIX)) continue;
    const userId = key.slice(LS_TOKEN_PREFIX.length);
    const token = localStorage.getItem(key);
    if (token && !(await getKey(`${TOKEN_PREFIX}${userId}`))) {
      await saveKey(`${TOKEN_PREFIX}${userId}`, token);
    }
  }
}

export async function saveSessionToken(userId: string, token: string) {
  await migrateFromLocalStorage();
  await saveKey(LAST_USER_KEY, userId);
  await saveKey(`${TOKEN_PREFIX}${userId}`, token);
  localStorage.setItem(LS_LAST_USER_KEY, userId);
  localStorage.setItem(`${LS_TOKEN_PREFIX}${userId}`, token);
}

export async function loadSessionToken(userId: string): Promise<string | null> {
  // Try localStorage first (faster, more reliable on cold start)
  const fromLs = localStorage.getItem(`${LS_TOKEN_PREFIX}${userId}`);
  if (fromLs) return fromLs;
  // Fall back to IndexedDB with timeout (skip migration to avoid hangs)
  try {
    const result = await Promise.race([
      getKey(`${TOKEN_PREFIX}${userId}`),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
    ]);
    // Populate localStorage for next time
    if (result) {
      try {
        localStorage.setItem(`${LS_TOKEN_PREFIX}${userId}`, result);
      } catch { /* ignore */ }
    }
    return result ?? null;
  } catch {
    return null;
  }
}

/**
 * Cold-start variant used while the splash screen is still visible.
 * iOS can take more than the normal 2s fallback after a notification wakes a
 * terminated PWA. Do not turn that slow IndexedDB open into a logged-out state;
 * the caller owns the overall splash timeout.
 */
export async function loadSessionTokenReliable(userId: string): Promise<string | null> {
  const fromLs = localStorage.getItem(`${LS_TOKEN_PREFIX}${userId}`);
  if (fromLs) return fromLs;
  try {
    const result = await getKey(`${TOKEN_PREFIX}${userId}`);
    if (result) localStorage.setItem(`${LS_TOKEN_PREFIX}${userId}`, result);
    return result ?? null;
  } catch {
    return null;
  }
}

export async function loadLastUserId(): Promise<string | null> {
  // Try localStorage first (faster, more reliable on cold start)
  const fromLs = localStorage.getItem(LS_LAST_USER_KEY);
  if (fromLs) return fromLs;
  // Fall back to IndexedDB with timeout (skip migration to avoid hangs)
  try {
    const result = await Promise.race([
      getKey(LAST_USER_KEY),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
    ]);
    // Populate localStorage for next time
    if (result) {
      try {
        localStorage.setItem(LS_LAST_USER_KEY, result);
      } catch { /* ignore */ }
    }
    return result ?? null;
  } catch {
    return null;
  }
}

export async function clearSessionToken(userId: string) {
  await migrateFromLocalStorage();
  await deleteKey(`${TOKEN_PREFIX}${userId}`);
  localStorage.removeItem(`${LS_TOKEN_PREFIX}${userId}`);

  const last = (await loadLastUserId()) ?? localStorage.getItem(LS_LAST_USER_KEY);
  if (last === userId) {
    await deleteKey(LAST_USER_KEY);
    localStorage.removeItem(LS_LAST_USER_KEY);
  }
}
