import { useEffect, useState } from 'react';
import { api, getAuthToken, onAuthTokenChange } from '../lib/api';

const cache = new Map<string, string>();

function cacheKey(userId: string, updatedAt: number | null | undefined) {
  return `${userId}:${updatedAt ?? 0}`;
}

/**
 * Resolve avatar URL:
 * 1) CDN URL from API (fast)
 * 2) authenticated blob from GET /users/{id}/avatar
 */
export function useAvatarUrl(
  userId: string,
  hasAvatar: boolean,
  avatarUpdatedAt: number | null | undefined,
  avatarUrl?: string | null,
  /** When CDN <img> fails (403/CORS), parent flips this to force blob fetch. */
  preferBlob = false,
): string | null {
  const key = cacheKey(userId, avatarUpdatedAt);
  const cdn = !preferBlob && avatarUrl ? avatarUrl : null;

  const [url, setUrl] = useState<string | null>(() => {
    if (cdn) return cdn;
    return hasAvatar ? cache.get(key) ?? null : null;
  });
  const [authEpoch, setAuthEpoch] = useState(0);

  useEffect(() => onAuthTokenChange(() => setAuthEpoch((n) => n + 1)), []);

  useEffect(() => {
    if (cdn) {
      setUrl(cdn);
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
  }, [userId, hasAvatar, key, cdn, authEpoch]);

  if (cdn) return cdn;
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
