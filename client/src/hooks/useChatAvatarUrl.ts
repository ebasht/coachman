import { useEffect, useState } from 'react';
import { api, getAuthToken, onAuthTokenChange } from '../lib/api';

const cache = new Map<string, string>();

function cacheKey(chatId: string, updatedAt: number | null | undefined) {
  return `${chatId}:${updatedAt ?? 0}`;
}

/**
 * Resolve group chat avatar URL via authenticated GET /chats/{id}/avatar
 * (CDN only when same-origin and preferBlob is false).
 */
export function useChatAvatarUrl(
  chatId: string,
  hasAvatar: boolean,
  avatarUpdatedAt: number | null | undefined,
  avatarUrl?: string | null,
  preferBlob = false,
): string | null {
  const key = cacheKey(chatId, avatarUpdatedAt);
  const cdn = !preferBlob && avatarUrl && avatarUrl.startsWith(window.location.origin)
    ? avatarUrl
    : null;

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
    if (!hasAvatar || !chatId) {
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
        .getChatAvatarBlob(chatId)
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
  }, [chatId, hasAvatar, key, cdn, authEpoch]);

  if (cdn) return cdn;
  return hasAvatar ? url : null;
}

export function invalidateChatAvatarCache(chatId: string) {
  for (const [k, url] of cache) {
    if (k.startsWith(`${chatId}:`)) {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      cache.delete(k);
    }
  }
}
