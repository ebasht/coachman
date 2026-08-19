/** Survives React remount / brief auth gaps so ringing UI can be restored. */
const STORAGE_KEY = 'coachman.pendingCallInvite';
const DISMISSED_KEY = 'coachman.dismissedCallIds';
/** Written by the service worker on push so a cold start (icon launch) can restore the invite. */
export const PENDING_CALL_CACHE = 'coachman-pending-call';
export const PENDING_CALL_URL = '/__coachman_pending_call';
export const DISMISSED_CALL_URL_PREFIX = '/__coachman_call_ended/';
export const PENDING_CALL_INVITE_TTL_MS = 45_000;
/** Keep ended-call tombstones long enough for stale iOS notification trays. */
export const DISMISSED_CALL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type PendingCallInvite = {
  chatId: string;
  callId: string;
  fromUserId?: string;
  savedAt: number;
};

function parseInvite(raw: unknown): PendingCallInvite | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as PendingCallInvite;
  if (
    typeof data.chatId !== 'string' ||
    typeof data.callId !== 'string' ||
    typeof data.savedAt !== 'number'
  ) {
    return null;
  }
  if (Date.now() - data.savedAt > PENDING_CALL_INVITE_TTL_MS) return null;
  return {
    chatId: data.chatId,
    callId: data.callId,
    fromUserId: typeof data.fromUserId === 'string' ? data.fromUserId : undefined,
    savedAt: data.savedAt,
  };
}

function readDismissed(): Record<string, number> {
  try {
    const raw = sessionStorage.getItem(DISMISSED_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw) as Record<string, number>;
    if (!data || typeof data !== 'object') return {};
    const now = Date.now();
    const next: Record<string, number> = {};
    for (const [id, at] of Object.entries(data)) {
      if (typeof at === 'number' && now - at < DISMISSED_CALL_TTL_MS) {
        next[id] = at;
      }
    }
    return next;
  } catch {
    return {};
  }
}

export function markCallDismissed(callId: string): void {
  if (!callId) return;
  try {
    const next = readDismissed();
    next[callId] = Date.now();
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  // Cache Storage is shared with the service worker and survives a terminated
  // PWA session. sessionStorage alone cannot protect a cold start from a stale
  // incoming-call notification.
  void caches
    .open(PENDING_CALL_CACHE)
    .then((cache) =>
      cache.put(
        `${DISMISSED_CALL_URL_PREFIX}${encodeURIComponent(callId)}`,
        new Response(String(Date.now())),
      ),
    )
    .catch(() => {});
}

export function isCallDismissed(callId: string): boolean {
  if (!callId) return false;
  return !!readDismissed()[callId];
}

export async function isCallDismissedAsync(callId: string): Promise<boolean> {
  if (isCallDismissed(callId)) return true;
  if (!callId) return false;
  try {
    const cache = await caches.open(PENDING_CALL_CACHE);
    const res = await cache.match(`${DISMISSED_CALL_URL_PREFIX}${encodeURIComponent(callId)}`);
    if (!res) return false;
    const at = Number(await res.text());
    if (!Number.isFinite(at) || Date.now() - at < DISMISSED_CALL_TTL_MS) {
      return true;
    }
    await cache.delete(`${DISMISSED_CALL_URL_PREFIX}${encodeURIComponent(callId)}`);
  } catch {
    // sessionStorage check above remains the fallback
  }
  return false;
}

export function savePendingCallInvite(invite: Omit<PendingCallInvite, 'savedAt'>): void {
  if (isCallDismissed(invite.callId)) return;
  const payload: PendingCallInvite = { ...invite, savedAt: Date.now() };
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // private mode / quota
  }
  void caches
    .open(PENDING_CALL_CACHE)
    .then((cache) =>
      cache.put(
        PENDING_CALL_URL,
        new Response(JSON.stringify(payload), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    .catch(() => {});
}

export function loadPendingCallInvite(): PendingCallInvite | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = parseInvite(JSON.parse(raw));
    if (!parsed || isCallDismissed(parsed.callId)) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Prefer sessionStorage; fall back to Cache API entry written by the SW on push. */
export async function loadPendingCallInviteAsync(): Promise<PendingCallInvite | null> {
  const local = loadPendingCallInvite();
  if (local) {
    if (await isCallDismissedAsync(local.callId)) {
      clearPendingCallInvite(local.callId);
      return null;
    }
    return local;
  }
  try {
    const cache = await caches.open(PENDING_CALL_CACHE);
    const res = await cache.match(PENDING_CALL_URL);
    if (!res) return null;
    const parsed = parseInvite(await res.json());
    if (!parsed || (await isCallDismissedAsync(parsed.callId))) {
      await cache.delete(PENDING_CALL_URL);
      return null;
    }
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
    } catch {
      // ignore
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingCallInvite(callId?: string): void {
  // Do NOT markCallDismissed here — that is only for explicit decline / call-ended.
  // Accept also clears the pending invite; marking dismissed would abort acceptFromNative
  // and make the next WS invite auto-send reject.
  try {
    if (!callId) {
      sessionStorage.removeItem(STORAGE_KEY);
    } else {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as PendingCallInvite;
          if (!parsed?.callId || parsed.callId === callId) {
            sessionStorage.removeItem(STORAGE_KEY);
          }
        } catch {
          sessionStorage.removeItem(STORAGE_KEY);
        }
      }
    }
  } catch {
    // ignore
  }
  void caches
    .open(PENDING_CALL_CACHE)
    .then(async (cache) => {
      if (!callId) {
        await cache.delete(PENDING_CALL_URL);
        return;
      }
      const res = await cache.match(PENDING_CALL_URL);
      if (!res) return;
      const parsed = parseInvite(await res.json());
      if (!parsed || parsed.callId === callId) {
        await cache.delete(PENDING_CALL_URL);
      }
    })
    .catch(() => {});
}

/** Explicit decline / remote hangup — blocks invite restore for this callId. */
export function dismissCallInvite(callId: string): void {
  if (!callId) return;
  markCallDismissed(callId);
  clearPendingCallInvite(callId);
}
