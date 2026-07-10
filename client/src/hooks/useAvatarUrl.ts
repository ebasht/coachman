import { useEffect, useState } from 'react';
import { api } from '../lib/api';

const cache = new Map<string, string>();

function cacheKey(userId: string, updatedAt: number | null | undefined) {
  return `${userId}:${updatedAt ?? 0}`;
}

/** Fallback when CDN URL is missing (local/dev without S3 public URL). */
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

    void api
      .getAvatarBlob(userId)
      .then((blob) => {
        if (cancelled) return;
        const objectUrl = URL.createObjectURL(blob);
        cache.set(key, objectUrl);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [userId, hasAvatar, key, avatarUrl]);

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
