import type { StoredMessage } from './storage';
import { albumRange, messagePreview } from './chat-format';
import {
  escapeMessageIdForSelector,
  messageAnchorSelector,
} from './chat-viewport';

/** Denormalized quote fields kept locally so the bubble stays useful if the parent is gone. */
export type ReplySnapshot = {
  replyToMessageId: string;
  replyToSenderId: string;
  replyToSenderName: string;
  replyToPreview: string;
  replyToType: StoredMessage['type'];
};

/** Highlight duration after jumping to a reply target (ms). */
export const REPLY_TARGET_HIGHLIGHT_MS = 1400;

export function canReplyToMessage(m: StoredMessage): boolean {
  if (m.pending || m.failed) return false;
  if (m.id.startsWith('pending-')) return false;
  return m.type === 'text' || m.type === 'image' || m.type === 'video';
}

/**
 * Resolve the DOM wrap for a reply target by exact message id (TASK-037).
 * Album tiles after the first are absorbed into the first member's wrap — when the
 * target is a later album photo, return that shared wrap (still keyed by the
 * first member's id in the DOM).
 */
export function findReplyTargetElement(
  root: ParentNode,
  messageId: string,
  messages: StoredMessage[],
): HTMLElement | null {
  const direct = root.querySelector(messageAnchorSelector(messageId));
  if (direct instanceof HTMLElement) return direct;

  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx < 0) return null;
  const range = albumRange(messages, idx);
  if (!range) return null;
  const first = messages[range.start];
  if (!first || first.id === messageId) return null;
  const albumEl = root.querySelector(messageAnchorSelector(first.id));
  return albumEl instanceof HTMLElement ? albumEl : null;
}

/** Exact id lookup — never approximate by timestamp. */
export function findMessageById(
  messages: StoredMessage[],
  messageId: string,
): StoredMessage | undefined {
  return messages.find((m) => m.id === messageId);
}

export { escapeMessageIdForSelector, messageAnchorSelector };

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
