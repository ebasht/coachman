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
  await migrateFromLocalStorage();
  const fromIdb = await getKey(`${TOKEN_PREFIX}${userId}`);
  if (fromIdb) return fromIdb;
  return localStorage.getItem(`${LS_TOKEN_PREFIX}${userId}`);
}

export async function loadLastUserId(): Promise<string | null> {
  await migrateFromLocalStorage();
  const fromIdb = await getKey(LAST_USER_KEY);
  if (fromIdb) return fromIdb;
  return localStorage.getItem(LS_LAST_USER_KEY);
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
