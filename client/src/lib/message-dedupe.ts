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
