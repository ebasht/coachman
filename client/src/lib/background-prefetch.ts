/**
 * Background prefetch used by the service worker on push.
 * Pulls new messages + plaintext photo bytes into IndexedDB so a cold open
 * already has history/photos without waiting on the network.
 */
import {
  getCachedImage,
  getChatMessageCursor,
  loadBackgroundAuthToken,
  saveCachedImage,
  savePrefetchMessages,
  takePrefetchMessages,
  type PrefetchMessage,
} from './storage';

const MAX_MESSAGES = 40;
const MAX_IMAGES = 12;
const FETCH_TIMEOUT_MS = 12_000;

type ApiMessage = {
  id: string;
  chatId: string;
  senderId: string;
  ciphertext: string;
  iv: string;
  type: string;
  imageId?: string;
  albumId?: string;
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

async function prefetchImageBytes(imageId: string, token: string): Promise<void> {
  if (!imageId) return;
  const existing = await getCachedImage(imageId);
  if (existing?.data?.byteLength) return;

  const meta = await apiGetJson<{
    url?: string;
    ciphertext?: string;
    iv: string;
    mimeType: string;
  }>(`/api/images/${encodeURIComponent(imageId)}`, token);

  let bytes: ArrayBuffer | null = null;
  const mime = meta.mimeType || 'image/jpeg';

  if (meta.url) {
    const res = await withTimeout(fetch(meta.url, { mode: 'cors', credentials: 'omit' }), FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`image GET ${res.status}`);
    bytes = await res.arrayBuffer();
  } else if (meta.ciphertext && (meta.iv === 'plain' || !meta.iv)) {
    // Inline plaintext payload (legacy API path).
    const bin = atob(meta.ciphertext);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    bytes = out.buffer;
  }
  // Encrypted legacy images: leave for the app (needs private keys).

  if (bytes && bytes.byteLength > 0) {
    await saveCachedImage(imageId, bytes, mime);
  }
}

/**
 * Called from the service worker inside push event.waitUntil.
 * Safe to fail — notification still shows; app will fetch on open.
 */
export async function prefetchChatInBackground(chatId: string): Promise<number> {
  if (!chatId) return 0;
  const token = await loadBackgroundAuthToken();
  if (!token) return 0;

  const after = await getChatMessageCursor(chatId);
  const batch = await apiGetJson<ApiMessage[]>(
    `/api/chats/${encodeURIComponent(chatId)}/messages?after=${after}`,
    token,
  );
  if (!Array.isArray(batch) || batch.length === 0) return 0;

  const slice = batch.slice(-MAX_MESSAGES);
  const now = Date.now();
  const rows: PrefetchMessage[] = slice.map((m) => ({
    id: m.id,
    chatId: m.chatId || chatId,
    senderId: m.senderId,
    ciphertext: m.ciphertext,
    iv: m.iv,
    type: m.type,
    imageId: m.imageId,
    albumId: m.albumId,
    clientId: m.clientId,
    createdAt: m.createdAt,
    prefetchedAt: now,
  }));
  await savePrefetchMessages(rows);

  const imageIds = [
    ...new Set(
      rows
        .filter((m) => m.type === 'image' && m.imageId)
        .map((m) => m.imageId as string),
    ),
  ].slice(0, MAX_IMAGES);

  // Parallel but bounded — push handlers have a short wall clock on iOS.
  const concurrency = 3;
  for (let i = 0; i < imageIds.length; i += concurrency) {
    const chunk = imageIds.slice(i, i + concurrency);
    await Promise.all(
      chunk.map((id) =>
        prefetchImageBytes(id, token).catch(() => {
          /* best-effort */
        }),
      ),
    );
  }

  return rows.length;
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
    clientId: m.clientId,
    createdAt: m.createdAt,
  }));
}
