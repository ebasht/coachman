/** Survives React remount / brief auth gaps so ringing UI can be restored. */
const STORAGE_KEY = 'coachman.pendingCallInvite';
/** Written by the service worker on push so a cold start (icon launch) can restore the invite. */
export const PENDING_CALL_CACHE = 'coachman-pending-call';
export const PENDING_CALL_URL = '/__coachman_pending_call';
export const PENDING_CALL_INVITE_TTL_MS = 60_000;

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

export function savePendingCallInvite(invite: Omit<PendingCallInvite, 'savedAt'>): void {
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
    if (!parsed) {
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
  if (local) return local;
  try {
    const cache = await caches.open(PENDING_CALL_CACHE);
    const res = await cache.match(PENDING_CALL_URL);
    if (!res) return null;
    const parsed = parseInvite(await res.json());
    if (!parsed) {
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
  try {
    if (callId) {
      const cur = loadPendingCallInvite();
      if (!cur || cur.callId === callId) {
        sessionStorage.removeItem(STORAGE_KEY);
      }
    } else {
      sessionStorage.removeItem(STORAGE_KEY);
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
