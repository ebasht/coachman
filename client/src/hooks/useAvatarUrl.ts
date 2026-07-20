import { useEffect, useState } from 'react';
import { api, getAuthToken, onAuthTokenChange } from '../lib/api';

const cache = new Map<string, string>();

function cacheKey(userId: string, updatedAt: number | null | undefined) {
  return `${userId}:${updatedAt ?? 0}`;
}

/** Resolve avatar: prefer CDN URL from API, else authenticated blob fetch. */
export function useAvatarUrl(
  userId: string,
  hasAvatar: boolean,
  avatarUpdatedAt: number | null | undefined,
  avatarUrl?: string | null,
): string | null {
  const key = cacheKey(userId, avatarUpdatedAt);
  const [url, setUrl] = useState<string | null>(() => {
    if (avatarUrl) return avatarUrl;
    return hasAvatar ? cache.get(key) ?? null : null;
  });
  const [authEpoch, setAuthEpoch] = useState(0);

  useEffect(() => onAuthTokenChange(() => setAuthEpoch((n) => n + 1)), []);

  useEffect(() => {
    if (avatarUrl) {
      setUrl(avatarUrl);
      return;
    }
    if (!hasAvatar || !userId) {
      setUrl(null);
      return;
    }

    const cached = cache.get(key);
    if (cached) {
      setUrl(cached);
      return;
    }

    let cancelled = false;
    let attempt = 0;
    let retryTimer: number | undefined;

    const load = () => {
      // Do not gate on getAuthToken() — getAvatarBlob → ensureAuthToken can
      // load the JWT from IDB. A hard gate left cold-start avatars stuck forever.
      void api
        .getAvatarBlob(userId)
        .then((blob) => {
          if (cancelled) return;
          if (!blob || blob.size === 0) throw new Error('empty avatar');
          const objectUrl = URL.createObjectURL(blob);
          cache.set(key, objectUrl);
          setUrl(objectUrl);
        })
        .catch(() => {
          if (cancelled) return;
          if (attempt < 6) {
            attempt += 1;
            // If auth is still missing, wait for token / loader; otherwise back off.
            const delay = getAuthToken() ? 300 * attempt : 400;
            retryTimer = window.setTimeout(load, delay);
            return;
          }
          setUrl(null);
        });
    };

    load();

    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [userId, hasAvatar, key, avatarUrl, authEpoch]);

  if (avatarUrl) return avatarUrl;
  return hasAvatar ? url : null;
}

export function invalidateAvatarCache(userId: string) {
  for (const [k, url] of cache) {
    if (k.startsWith(`${userId}:`)) {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      cache.delete(k);
    }
  }
}
