import type { StoredMessage } from './storage';
import { messagePreview } from './chat-format';

/** Denormalized quote fields kept locally so the bubble stays useful if the parent is gone. */
export type ReplySnapshot = {
  replyToMessageId: string;
  replyToSenderId: string;
  replyToSenderName: string;
  replyToPreview: string;
  replyToType: StoredMessage['type'];
};

export function canReplyToMessage(m: StoredMessage): boolean {
  if (m.pending || m.failed) return false;
  if (m.id.startsWith('pending-')) return false;
  return m.type === 'text' || m.type === 'image';
}

export function buildReplySnapshot(m: StoredMessage): ReplySnapshot {
  return {
    replyToMessageId: m.id,
    replyToSenderId: m.senderId,
    replyToSenderName: m.senderName || '…',
    replyToPreview: messagePreview(m),
    replyToType: m.type,
  };
}

/** Fill missing quote previews from parents in the same list (Telegram-style). */
export function fillReplySnapshots(messages: StoredMessage[]): StoredMessage[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  return messages.map((m) => {
    if (!m.replyToMessageId) return m;
    if (m.replyToPreview) return m;
    const parent = byId.get(m.replyToMessageId);
    if (!parent) return m;
    return { ...m, ...buildReplySnapshot(parent) };
  });
}

export function replyFieldsFromRaw(
  replyToMessageId: string | undefined,
  messages: StoredMessage[],
  fallback?: Partial<StoredMessage>,
): Partial<StoredMessage> {
  if (!replyToMessageId) return {};
  const parent = messages.find((m) => m.id === replyToMessageId);
  if (parent) return buildReplySnapshot(parent);
  if (fallback?.replyToMessageId === replyToMessageId) {
    return {
      replyToMessageId,
      replyToSenderId: fallback.replyToSenderId,
      replyToSenderName: fallback.replyToSenderName,
      replyToPreview: fallback.replyToPreview,
      replyToType: fallback.replyToType,
    };
  }
  return { replyToMessageId };
}
