/**
 * Background download of messages + photos (service worker push / Capacitor FCM /
 * app while backgrounded). Ciphertext lands in IDB `prefetch`; plaintext photo
 * bytes in `imageCache`. The app decrypts prefetch rows when it is awake.
 */
import {
  getCachedImage,
  getChatMessageCursor,
  getMessages,
  loadBackgroundAuthToken,
  enqueueBackgroundSyncChats,
  takeBackgroundSyncChats,
  saveCachedImage,
  savePrefetchMessages,
  takePrefetchMessages,
  type PrefetchMessage,
} from './storage';

const PAGE_LIMIT = 100;
const MAX_PAGES = 5;
const MAX_IMAGES = 48;
const FETCH_TIMEOUT_MS = 20_000;
const IMAGE_CONCURRENCY = 4;

type ApiMessage = {
  id: string;
  chatId: string;
  senderId: string;
  ciphertext: string;
  iv: string;
  type: string;
  imageId?: string;
  albumId?: string;
  replyToMessageId?: string;
  clientId?: string;
  createdAt: number;
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('prefetch timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function apiGetJson<T>(path: string, token: string): Promise<T> {
  const res = await withTimeout(
    fetch(path, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      credentials: 'same-origin',
    }),
    FETCH_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`prefetch HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function prefetchImageBytes(imageId: string, token: string): Promise<boolean> {
  if (!imageId) return false;
  const existing = await getCachedImage(imageId);
  if (existing?.data?.byteLength) return false;

  const meta = await apiGetJson<{
    url?: string;
    ciphertext?: string;
    iv: string;
    mimeType: string;
  }>(`/api/images/${encodeURIComponent(imageId)}`, token);

  let bytes: ArrayBuffer | null = null;
  const mime = meta.mimeType || 'image/jpeg';

  if (meta.url) {
    try {
      const res = await withTimeout(fetch(meta.url, { mode: 'cors', credentials: 'omit' }), FETCH_TIMEOUT_MS);
      if (!res.ok) throw new Error(`image GET ${res.status}`);
      bytes = await res.arrayBuffer();
    } catch {
      const res = await withTimeout(
        fetch(`/api/images/${encodeURIComponent(imageId)}/bytes`, {
          headers: { Authorization: `Bearer ${token}` },
          credentials: 'same-origin',
        }),
        FETCH_TIMEOUT_MS,
      );
      if (!res.ok) throw new Error(`image bytes ${res.status}`);
      bytes = await res.arrayBuffer();
    }
  } else if (meta.ciphertext && (meta.iv === 'plain' || !meta.iv)) {
    const bin = atob(meta.ciphertext);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    bytes = out.buffer;
  }
  // Encrypted legacy images: leave for the app (needs private keys).

  if (bytes && bytes.byteLength > 0) {
    await saveCachedImage(imageId, bytes, mime);
    return true;
  }
  return false;
}

async function downloadImagesBounded(imageIds: string[], token: string): Promise<number> {
  const unique = [...new Set(imageIds.filter(Boolean))].slice(0, MAX_IMAGES);
  let saved = 0;
  for (let i = 0; i < unique.length; i += IMAGE_CONCURRENCY) {
    const chunk = unique.slice(i, i + IMAGE_CONCURRENCY);
    const results = await Promise.all(
      chunk.map((id) =>
        prefetchImageBytes(id, token).catch(() => false),
      ),
    );
    saved += results.filter(Boolean).length;
  }
  return saved;
}

/** Download missing photo bytes for messages already stored locally. */
export async function prefetchMissingLocalImages(chatId: string, token?: string): Promise<number> {
  if (!chatId) return 0;
  const auth = token ?? (await loadBackgroundAuthToken());
  if (!auth) return 0;
  const rows = await getMessages(chatId);
  const ids: string[] = [];
  for (const m of rows) {
    if (m.type === 'image' && m.imageId) ids.push(m.imageId);
  }
  // Prefer newest photos first.
  ids.reverse();
  return downloadImagesBounded(ids, auth);
}

/**
 * Pull new messages since local cursor (paginated) + download their photos,
 * then fill any missing local photo cache entries.
 */
export async function prefetchChatInBackground(chatId: string): Promise<number> {
  if (!chatId) return 0;
  const token = await loadBackgroundAuthToken();
  if (!token) return 0;

  let after = await getChatMessageCursor(chatId);
  let totalSaved = 0;
  const imageIds: string[] = [];
  const now = Date.now();

  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await apiGetJson<ApiMessage[]>(
      `/api/chats/${encodeURIComponent(chatId)}/messages?after=${after}&limit=${PAGE_LIMIT}`,
      token,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;

    const rows: PrefetchMessage[] = batch.map((m) => ({
      id: m.id,
      chatId: m.chatId || chatId,
      senderId: m.senderId,
      ciphertext: m.ciphertext,
      iv: m.iv,
      type: m.type,
      imageId: m.imageId,
      albumId: m.albumId,
      replyToMessageId: m.replyToMessageId,
      clientId: m.clientId,
      createdAt: m.createdAt,
      prefetchedAt: now,
    }));
    await savePrefetchMessages(rows);
    totalSaved += rows.length;

    for (const m of rows) {
      if (m.type === 'image' && m.imageId) imageIds.push(m.imageId);
      if (m.createdAt > after) after = m.createdAt;
    }

    if (batch.length < PAGE_LIMIT) break;
  }

  await downloadImagesBounded(imageIds, token);
  // Also warm cache for photos already decrypted earlier but never cached.
  await prefetchMissingLocalImages(chatId, token).catch(() => 0);

  return totalSaved;
}

/** Prefetch several chats sequentially (push may only name one; resume syncs more). */
export async function prefetchChatsInBackground(chatIds: string[]): Promise<number> {
  const unique = [...new Set(chatIds.filter(Boolean))];
  let total = 0;
  for (const id of unique) {
    try {
      total += await prefetchChatInBackground(id);
    } catch {
      /* best-effort per chat */
    }
  }
  return total;
}

/** Ask the SW to continue downloads if the page is suspended (Background Sync). */
export async function requestBackgroundMessageSync(chatIds: string[]): Promise<void> {
  const ids = [...new Set(chatIds.filter(Boolean))];
  if (!ids.length) return;
  await enqueueBackgroundSyncChats(ids);
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const syncManager = (reg as ServiceWorkerRegistration & {
      sync?: { register: (tag: string) => Promise<void> };
    }).sync;
    if (syncManager?.register) {
      await syncManager.register('coachman-prefetch');
    }
  } catch {
    /* unsupported or permission denied — push path still works */
  }
}

/** Drain queued chats (SW sync event / app resume). */
export async function runQueuedBackgroundPrefetch(): Promise<number> {
  const ids = await takeBackgroundSyncChats();
  if (!ids.length) return 0;
  return prefetchChatsInBackground(ids);
}

/** App-side: turn SW prefetch rows into RawMessage-shaped objects and clear the queue. */
export async function consumePrefetchedMessages(chatId: string): Promise<
  {
    id: string;
    chatId: string;
    senderId: string;
    ciphertext: string;
    iv: string;
    type: 'text' | 'image' | 'call' | 'list';
    imageId?: string;
    albumId?: string;
    replyToMessageId?: string;
    clientId?: string;
    createdAt: number;
  }[]
> {
  const rows = await takePrefetchMessages(chatId);
  return rows.map((m) => ({
    id: m.id,
    chatId: m.chatId,
    senderId: m.senderId,
    ciphertext: m.ciphertext,
    iv: m.iv,
    type: (m.type as 'text' | 'image' | 'call' | 'list') || 'text',
    imageId: m.imageId,
    albumId: m.albumId,
    replyToMessageId: m.replyToMessageId,
    clientId: m.clientId,
    createdAt: m.createdAt,
  }));
}
