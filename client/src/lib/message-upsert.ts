import type { StoredMessage } from './storage';
import { messageClientKey, mergeMessageEntity, sameMessageIdentity } from './message-identity';
import {
  getMessage,
  getMessages,
  removeOutboxByTempMessageId,
  replacePendingMessage,
  saveMessage,
} from './storage';

/**
 * Resolve the local row to merge without reading the whole chat history.
 * Own pending rows live at `pending-${clientId}`; peer inserts are keyed by server id.
 */
export async function findStoredMessageForUpsert(
  incoming: StoredMessage,
): Promise<StoredMessage | undefined> {
  const clientKey = messageClientKey(incoming);
  if (clientKey) {
    const pending = await getMessage(`pending-${clientKey}`);
    if (pending && sameMessageIdentity(pending, incoming)) return pending;
  }
  const byId = incoming.id ? await getMessage(incoming.id) : undefined;
  if (byId && sameMessageIdentity(byId, incoming)) return byId;
  if (!clientKey) return undefined;
  // Legacy pending rows that were not stored as pending-${clientId}.
  const existing = await getMessages(incoming.chatId);
  return (
    existing.find((m) => m.pending && sameMessageIdentity(m, incoming)) ||
    existing.find((m) => sameMessageIdentity(m, incoming))
  );
}

/**
 * Idempotent local upsert used by HTTP ACK, WebSocket, history sync, and outbox.
 * Priority: server id → clientId → temp pending id.
 */
export async function upsertStoredMessage(incoming: StoredMessage): Promise<StoredMessage> {
  const chatId = incoming.chatId;
  if (!chatId || !incoming.id) {
    throw new Error('upsertStoredMessage: id and chatId required');
  }

  const match = await findStoredMessageForUpsert(incoming);
  const pending = match?.pending ? match : undefined;
  const base = pending || match;

  const confirmedIncoming: StoredMessage = {
    ...incoming,
    pending: false,
    failed: false,
    error: undefined,
  };
  const merged = base
    ? mergeMessageEntity(base, confirmedIncoming)
    : confirmedIncoming;

  if (pending && pending.id !== merged.id) {
    await replacePendingMessage(pending.id, merged);
    if (pending.clientId) {
      await removeOutboxByTempMessageId(pending.clientId).catch(() => undefined);
    }
    await removeOutboxByTempMessageId(pending.id).catch(() => undefined);
  } else {
    await saveMessage(merged);
    if (merged.clientId) {
      await removeOutboxByTempMessageId(merged.clientId).catch(() => undefined);
    }
  }

  return merged;
}

/** Sort key: prefer server sequence, then createdAt, then id. */
export function compareMessages(a: StoredMessage, b: StoredMessage): number {
  const sa = a.sequence ?? 0;
  const sb = b.sequence ?? 0;
  if (sa && sb && sa !== sb) return sa - sb;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id.localeCompare(b.id);
}

export function maxMessageSequence(messages: StoredMessage[]): number {
  let max = 0;
  for (const m of messages) {
    if (m.sequence && m.sequence > max) max = m.sequence;
  }
  return max;
}
