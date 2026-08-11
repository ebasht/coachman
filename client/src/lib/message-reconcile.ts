import type { StoredMessage } from './storage';
import { mergeMessageEntity, sameMessageIdentity } from './message-identity';
import { compareMessages } from './message-upsert';
import { dedupeStoredMessages } from './message-dedupe';

function isFalsy(v: unknown): boolean {
  return v == null || v === false || v === '';
}

function messageUnchanged(existing: StoredMessage, merged: StoredMessage): boolean {
  const allKeys = new Set([
    ...Object.keys(existing),
    ...Object.keys(merged),
  ]) as Set<keyof StoredMessage>;
  for (const k of allKeys) {
    const ev = existing[k];
    const mv = merged[k];
    if (ev === mv) continue;
    if (isFalsy(ev) && isFalsy(mv)) continue;
    return false;
  }
  return true;
}

export interface ReconcileResult {
  /** The reconciled message list. */
  messages: StoredMessage[];
  /** The merged message entity that was inserted or updated. */
  message: StoredMessage;
  /** True only when a genuinely new logical message was added to the list. */
  inserted: boolean;
  /** True when an existing message was updated (pending→confirmed, field merge, etc.). */
  updated: boolean;
}

/**
 * Canonical in-memory reconciliation of a single incoming message into a message list.
 *
 * Handles every source: history, WebSocket, HTTP ACK, persisted messages, reconnect.
 * Identity is determined solely by server id / clientId — never by text or timestamp.
 */
export function reconcileMessage(
  prev: StoredMessage[],
  incoming: StoredMessage,
): ReconcileResult {
  const idx = prev.findIndex((m) => sameMessageIdentity(m, incoming));

  if (idx >= 0) {
    const existing = prev[idx]!;
    const merged = mergeMessageEntity(existing, incoming);

    if (merged === existing || messageUnchanged(existing, merged)) {
      return { messages: prev, message: existing, inserted: false, updated: false };
    }

    const copy = prev.slice();
    copy[idx] = merged;
    const messages = dedupeStoredMessages(copy).sort(compareMessages);
    return { messages, message: merged, inserted: false, updated: true };
  }

  const messages = dedupeStoredMessages([...prev, incoming]).sort(compareMessages);
  const message = messages.find((m) => sameMessageIdentity(m, incoming)) ?? incoming;
  return { messages, message, inserted: true, updated: false };
}

/**
 * Reconcile a batch of incoming messages (e.g. history sync, reconnect).
 * Folds each message sequentially to preserve correct identity resolution order.
 */
export function reconcileMessages(
  prev: StoredMessage[],
  batch: StoredMessage[],
): { messages: StoredMessage[]; results: ReconcileResult[] } {
  let current = prev;
  const results: ReconcileResult[] = [];
  for (const incoming of batch) {
    const result = reconcileMessage(current, incoming);
    current = result.messages;
    results.push(result);
  }
  return { messages: current, results };
}
