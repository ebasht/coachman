import type { StoredMessage } from './storage';
import {
  messageClientKey,
  mergeMessageEntity,
  sameMessageIdentity,
} from './message-identity';
import { compareMessages } from './message-upsert';

export {
  messageClientKey,
  mergeMessageEntity,
  messageServerId,
  sameMessageIdentity,
} from './message-identity';

/**
 * Collapse duplicates caused by offline outbox retries / reconnect.
 * Prefers confirmed over pending; identity is server id / clientId / pending-${clientId} only.
 * Content + timestamp are never authoritative identity.
 */
export function dedupeStoredMessages(messages: StoredMessage[]): StoredMessage[] {
  const sorted = [...messages].sort(compareMessages);
  const result: StoredMessage[] = [];
  const clientIndex = new Map<string, number>();
  const idIndex = new Map<string, number>();

  const prefer = (prev: StoredMessage, next: StoredMessage): StoredMessage =>
    mergeMessageEntity(prev, next);

  for (const m of sorted) {
    if (m.id && !m.pending && idIndex.has(m.id)) {
      const idx = idIndex.get(m.id)!;
      result[idx] = prefer(result[idx], m);
      continue;
    }

    const clientKey = messageClientKey(m);
    if (clientKey) {
      const idx = clientIndex.get(clientKey);
      if (idx != null) {
        result[idx] = prefer(result[idx], m);
        if (!m.pending) idIndex.set(m.id, idx);
        continue;
      }
      clientIndex.set(clientKey, result.length);
      if (!m.pending) idIndex.set(m.id, result.length);
      result.push(m);
      continue;
    }

    if (!m.pending) idIndex.set(m.id, result.length);
    result.push(m);
  }

  return result;
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
    const merged = mergeMessageEntity(prev[idx]!, incoming);
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
