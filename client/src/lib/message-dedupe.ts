import type { StoredMessage } from './storage';
import { compareMessages } from './message-upsert';

/**
 * Collapse duplicates caused by offline outbox retries / reconnect.
 * Prefers confirmed over pending; uses clientId / server id when present.
 */
export function dedupeStoredMessages(messages: StoredMessage[]): StoredMessage[] {
  const sorted = [...messages].sort(compareMessages);
  const result: StoredMessage[] = [];
  const clientIndex = new Map<string, number>();
  const idIndex = new Map<string, number>();

  const prefer = (prev: StoredMessage, next: StoredMessage): StoredMessage => {
    if (prev.pending && !next.pending) return next;
    if (!prev.pending && next.pending) return prev;
    if ((next.sequence ?? 0) > (prev.sequence ?? 0)) return next;
    if (next.createdAt >= prev.createdAt) return next;
    return prev;
  };

  for (const m of sorted) {
    if (m.id && !m.pending && idIndex.has(m.id)) {
      const idx = idIndex.get(m.id)!;
      result[idx] = prefer(result[idx], m);
      continue;
    }

    if (m.clientId) {
      const idx = clientIndex.get(m.clientId);
      if (idx != null) {
        result[idx] = prefer(result[idx], m);
        if (!m.pending) idIndex.set(m.id, idx);
        continue;
      }
      clientIndex.set(m.clientId, result.length);
      if (!m.pending) idIndex.set(m.id, result.length);
      result.push(m);
      continue;
    }

    // Legacy duplicates (no clientId): same sender/type/text within 5s.
    const dupIdx = result.findIndex(
      (x) =>
        !x.clientId &&
        x.senderId === m.senderId &&
        x.type === m.type &&
        x.text === m.text &&
        Math.abs(x.createdAt - m.createdAt) < 5_000,
    );
    if (dupIdx >= 0) {
      result[dupIdx] = prefer(result[dupIdx], m);
      continue;
    }
    if (!m.pending) idIndex.set(m.id, result.length);
    result.push(m);
  }

  return result;
}

/** Normalize client identity across bare uuid / pending-${uuid} / server rows. */
export function messageClientKey(
  m: Pick<StoredMessage, 'id' | 'clientId'>,
): string | undefined {
  if (m.clientId) return m.clientId;
  if (m.id.startsWith('pending-')) return m.id.slice('pending-'.length);
  return undefined;
}

export function sameMessageIdentity(
  a: Pick<StoredMessage, 'id' | 'clientId'>,
  b: Pick<StoredMessage, 'id' | 'clientId'>,
): boolean {
  if (a.id && b.id && a.id === b.id) return true;
  const aClient = messageClientKey(a);
  const bClient = messageClientKey(b);
  if (aClient && bClient && aClient === bClient) return true;
  return false;
}

function mergeUiMessage(prev: StoredMessage, next: StoredMessage): StoredMessage {
  const preferNext =
    prev.pending && !next.pending
      ? next
      : !prev.pending && next.pending
        ? prev
        : (next.sequence ?? 0) >= (prev.sequence ?? 0)
          ? next
          : prev;
  const other = preferNext === next ? prev : next;
  return {
    ...other,
    ...preferNext,
    // Keep hydrated media URLs so bubbles do not flash/remount.
    imageUrl: preferNext.imageUrl || other.imageUrl,
    posterUrl: preferNext.posterUrl || other.posterUrl,
    text: preferNext.text || other.text,
    clientId: preferNext.clientId || other.clientId,
  };
}

/**
 * In-memory upsert for ChatView list state.
 * Replaces pending/echo duplicates by id or clientId instead of blind append.
 */
export function upsertMessageInList(
  prev: StoredMessage[],
  incoming: StoredMessage,
): { next: StoredMessage[]; changed: boolean; inserted: boolean } {
  const idx = prev.findIndex((m) => sameMessageIdentity(m, incoming));
  if (idx >= 0) {
    const merged = mergeUiMessage(prev[idx]!, incoming);
    if (merged === prev[idx]) {
      return { next: prev, changed: false, inserted: false };
    }
    const copy = prev.slice();
    copy[idx] = merged;
    return {
      next: dedupeStoredMessages(copy).sort(compareMessages),
      changed: true,
      inserted: false,
    };
  }
  return {
    next: dedupeStoredMessages([...prev, incoming]).sort(compareMessages),
    changed: true,
    inserted: true,
  };
}

/** Resolve local bubble for an outbox tempMessageId (bare clientId or pending-*). */
export function findMessageByTempId(
  rows: StoredMessage[],
  tempMessageId: string,
): StoredMessage | undefined {
  const bare = tempMessageId.replace(/^pending-/, '');
  const pendingId = `pending-${bare}`;
  return rows.find(
    (m) =>
      m.id === tempMessageId ||
      m.id === bare ||
      m.id === pendingId ||
      m.clientId === bare ||
      m.clientId === tempMessageId,
  );
}
