import type { StoredMessage } from './storage';
import {
  getMessages,
  removeOutboxByTempMessageId,
  replacePendingMessage,
  saveMessage,
} from './storage';

/**
 * Idempotent local upsert used by HTTP ACK, WebSocket, history sync, and outbox.
 * Priority: server id → clientId → temp pending id.
 */
export async function upsertStoredMessage(incoming: StoredMessage): Promise<StoredMessage> {
  const chatId = incoming.chatId;
  if (!chatId || !incoming.id) {
    throw new Error('upsertStoredMessage: id and chatId required');
  }

  const existing = await getMessages(chatId);
  const byId = existing.find((m) => m.id === incoming.id);
  const byClient =
    incoming.clientId
      ? existing.find(
          (m) =>
            m.clientId === incoming.clientId ||
            m.id === incoming.clientId ||
            m.id === `pending-${incoming.clientId}`,
        )
      : undefined;

  const pending = [byId, byClient].find((m) => m?.pending);

  const merged: StoredMessage = {
    ...(pending || byId || byClient || {}),
    ...incoming,
    pending: false,
    failed: false,
    error: undefined,
    clientId: incoming.clientId || pending?.clientId || byClient?.clientId || byId?.clientId,
    text: incoming.text || pending?.text || byId?.text || byClient?.text || '',
    senderName: incoming.senderName || pending?.senderName || byId?.senderName || '?',
    imageUrl: incoming.imageUrl || pending?.imageUrl || byId?.imageUrl,
    albumId: incoming.albumId ?? pending?.albumId ?? byId?.albumId,
    replyToMessageId: incoming.replyToMessageId ?? pending?.replyToMessageId ?? byId?.replyToMessageId,
    replyToSenderId: incoming.replyToSenderId ?? pending?.replyToSenderId ?? byId?.replyToSenderId,
    replyToSenderName:
      incoming.replyToSenderName ?? pending?.replyToSenderName ?? byId?.replyToSenderName,
    replyToPreview: incoming.replyToPreview ?? pending?.replyToPreview ?? byId?.replyToPreview,
    replyToType: incoming.replyToType ?? pending?.replyToType ?? byId?.replyToType,
    sequence: incoming.sequence ?? pending?.sequence ?? byId?.sequence,
  };

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
