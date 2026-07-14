import type { StoredMessage } from './storage';

/**
 * Collapse duplicates caused by offline outbox retries / reconnect.
 * Prefers confirmed over pending; uses clientId when present.
 */
export function dedupeStoredMessages(messages: StoredMessage[]): StoredMessage[] {
  const sorted = [...messages].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const result: StoredMessage[] = [];
  const clientIndex = new Map<string, number>();

  for (const m of sorted) {
    if (m.clientId) {
      const idx = clientIndex.get(m.clientId);
      if (idx != null) {
        const prev = result[idx];
        if (prev.pending && !m.pending) {
          result[idx] = m;
        } else if (!prev.pending && m.pending) {
          // keep confirmed
        } else if (m.createdAt >= prev.createdAt) {
          result[idx] = m;
        }
        continue;
      }
      clientIndex.set(m.clientId, result.length);
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
      if (result[dupIdx].pending && !m.pending) {
        result[dupIdx] = m;
      }
      continue;
    }
    result.push(m);
  }

  return result;
}
