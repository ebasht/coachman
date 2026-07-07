const TOKEN_PREFIX = 'cm:token:';
const LAST_USER_KEY = 'cm:lastUserId';

export function saveSessionToken(userId: string, token: string) {
  localStorage.setItem(LAST_USER_KEY, userId);
  localStorage.setItem(`${TOKEN_PREFIX}${userId}`, token);
}

export function loadSessionToken(userId: string): string | null {
  return localStorage.getItem(`${TOKEN_PREFIX}${userId}`);
}

export function loadLastUserId(): string | null {
  return localStorage.getItem(LAST_USER_KEY);
}

export function clearSessionToken(userId: string) {
  localStorage.removeItem(`${TOKEN_PREFIX}${userId}`);
  const last = localStorage.getItem(LAST_USER_KEY);
  if (last === userId) {
    localStorage.removeItem(LAST_USER_KEY);
  }
}

export function restoreTokenFromStorage(onToken: (token: string) => void): string | null {
  const userId = loadLastUserId();
  if (!userId) return null;
  const token = loadSessionToken(userId);
  if (token) onToken(token);
  return userId;
}
