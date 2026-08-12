import type { RawMessage } from './api';
import type { StoredMessage } from './storage';

/** How many messages to paint on open (from the end). Older rows load on scroll-up. */
export const HISTORY_INITIAL_WINDOW = 150;

/** Server / client page size for history fetches. */
export const HISTORY_PAGE_SIZE = 100;

/** How many older local rows to prepend per scroll-up. */
export const HISTORY_PREPEND_CHUNK = 80;

const DECRYPT_FAILURE = '[не удалось расшифровать]';
const OWN_UNREADABLE = '[ваше сообщение]';

export function isDecryptPlaceholder(text: string): boolean {
  return text === DECRYPT_FAILURE || text === OWN_UNREADABLE;
}

/** True when IndexedDB already has readable plaintext we can show without crypto. */
export function hasUsablePlaintext(msg: StoredMessage): boolean {
  return !!msg.text && !isDecryptPlaceholder(msg.text);
}

/**
 * Reuse a local row instead of decrypting the server envelope again.
 * Applies to peer messages too — re-opening a large chat must not re-run WebCrypto
 * for every historical bubble.
 */
export function shouldReuseCachedMessage(
  existing: StoredMessage | undefined,
  raw: RawMessage,
): boolean {
  if (!existing || !hasUsablePlaintext(existing)) return false;
  if (existing.pending) return false;
  if (raw.type === 'image' || raw.type === 'video') {
    if (raw.imageId && existing.imageId && raw.imageId !== existing.imageId) return false;
  }
  return true;
}

export function maxMessageSequence(messages: Iterable<StoredMessage | RawMessage>): number {
  let max = 0;
  for (const m of messages) {
    const seq = m.sequence ?? 0;
    if (seq > max) max = seq;
  }
  return max;
}

export function minMessageSequence(messages: Iterable<StoredMessage | RawMessage>): number {
  let min = 0;
  for (const m of messages) {
    const seq = m.sequence ?? 0;
    if (seq <= 0) continue;
    if (min === 0 || seq < min) min = seq;
  }
  return min;
}

export type HistoryFetchMode = 'incremental' | 'latest';

/**
 * Warm cache with sequences → catch up only.
 * Empty / unscored cache → fetch the newest page (not oldest-first full history).
 */
export function historyFetchMode(cached: StoredMessage[]): HistoryFetchMode {
  if (cached.length > 0 && maxMessageSequence(cached) > 0) return 'incremental';
  return 'latest';
}

export function sliceRecentMessages(
  messages: StoredMessage[],
  windowSize = HISTORY_INITIAL_WINDOW,
): { visible: StoredMessage[]; older: StoredMessage[] } {
  if (messages.length <= windowSize) {
    return { visible: messages, older: [] };
  }
  const cut = messages.length - windowSize;
  return {
    older: messages.slice(0, cut),
    visible: messages.slice(cut),
  };
}

/** Take up to `limit` newest rows from the older (ascending) buffer. */
export function takeOlderChunk(
  olderAscending: StoredMessage[],
  limit = HISTORY_PREPEND_CHUNK,
): { chunk: StoredMessage[]; remaining: StoredMessage[] } {
  if (olderAscending.length <= limit) {
    return { chunk: olderAscending, remaining: [] };
  }
  const cut = olderAscending.length - limit;
  return {
    remaining: olderAscending.slice(0, cut),
    chunk: olderAscending.slice(cut),
  };
}

export function indexMessagesById(messages: StoredMessage[]): Map<string, StoredMessage> {
  const map = new Map<string, StoredMessage>();
  for (const m of messages) map.set(m.id, m);
  return map;
}

/**
 * Find a pending own message that matches a server ACK (clientId / pending- id).
 */
export function findMatchingPending(
  cached: StoredMessage[],
  msg: RawMessage,
  userId: string,
): StoredMessage | undefined {
  if (msg.senderId !== userId || !msg.clientId) return undefined;
  return cached.find(
    (m) =>
      m.pending &&
      m.senderId === userId &&
      (m.clientId === msg.clientId ||
        m.id === msg.clientId ||
        m.id === `pending-${msg.clientId}`),
  );
}

/** True when a full page came back — there may be older remote history. */
export function pageMayHaveOlder(pageLength: number, pageSize = HISTORY_PAGE_SIZE): boolean {
  return pageLength >= pageSize;
}
