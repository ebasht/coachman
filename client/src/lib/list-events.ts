import type { Chat } from './api';
import { encryptChatMessage } from './messages-encrypt';
import { isOnline } from './network';
import { enqueueListEventOutbox, flushOutbox } from './outbox';
import { getMessages, saveMessage, type StoredMessage } from './storage';

export type ListEventKind = 'item_add' | 'item_done' | 'item_undone' | 'item_delete';

export type ListEventReport = {
  chatId: string;
  eventId: string;
  kind: ListEventKind;
  /** Plaintext of the list item (encrypted inside the message payload). */
  itemText?: string;
};

type ListEventPayload = {
  v: 1;
  kind: ListEventKind;
  eventId: string;
  itemText?: string;
};

const ITEM_TEXT_MAX = 120;

export function normalizeListItemText(text: string | undefined | null): string {
  const normalized = (text ?? '').trim().replace(/\s+/g, ' ');
  if (!normalized) return '';
  const chars = Array.from(normalized);
  if (chars.length <= ITEM_TEXT_MAX) return normalized;
  return chars.slice(0, ITEM_TEXT_MAX - 1).join('') + '…';
}

export function formatListEventLabel(kind: ListEventKind, itemText?: string): string {
  const quote = normalizeListItemText(itemText);
  switch (kind) {
    case 'item_add':
      return quote ? `Добавлено в список: ${quote}` : 'Добавлен пункт в список';
    case 'item_done':
      return quote ? `Выполнено: ${quote}` : 'Пункт отмечен выполненным';
    case 'item_undone':
      return quote ? `Снята отметка: ${quote}` : 'С пункта снята отметка';
    case 'item_delete':
      return quote ? `Удалено из списка: ${quote}` : 'Пункт удалён из списка';
    default:
      return 'Список обновлён';
  }
}

export function encodeListEventPayload(ev: ListEventReport): string {
  const payload: ListEventPayload = {
    v: 1,
    kind: ev.kind,
    eventId: ev.eventId,
  };
  const itemText = normalizeListItemText(ev.itemText);
  if (itemText) payload.itemText = itemText;
  return JSON.stringify(payload);
}

export function parseListEventPayload(text: string): ListEventPayload | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const data = JSON.parse(trimmed) as Partial<ListEventPayload>;
    if (data.v !== 1 || typeof data.eventId !== 'string' || typeof data.kind !== 'string') {
      return null;
    }
    if (
      data.kind !== 'item_add' &&
      data.kind !== 'item_done' &&
      data.kind !== 'item_undone' &&
      data.kind !== 'item_delete'
    ) {
      return null;
    }
    const itemText =
      typeof data.itemText === 'string' ? normalizeListItemText(data.itemText) : undefined;
    return {
      v: 1,
      kind: data.kind,
      eventId: data.eventId,
      ...(itemText ? { itemText } : {}),
    };
  } catch {
    return null;
  }
}

export function listEventDisplayText(text: string): string {
  const parsed = parseListEventPayload(text);
  if (!parsed) return text || 'Список обновлён';
  return formatListEventLabel(parsed.kind, parsed.itemText);
}

function messageMentionsEventId(msg: StoredMessage, eventId: string): boolean {
  if (msg.type !== 'list') return false;
  if (msg.text.includes(eventId)) return true;
  return parseListEventPayload(msg.text)?.eventId === eventId;
}

/** Persist + queue an encrypted list-change system message. */
export async function postListEventMessage(opts: {
  event: ListEventReport;
  chat: Chat;
  userId: string;
  username: string;
  privateKeyB64: string;
  onLocalMessage?: (msg: StoredMessage) => void;
}): Promise<void> {
  const { event, chat, userId, username, privateKeyB64, onLocalMessage } = opts;
  const existing = await getMessages(event.chatId);
  if (existing.some((m) => messageMentionsEventId(m, event.eventId))) {
    return;
  }

  const payload = encodeListEventPayload(event);
  const label = formatListEventLabel(event.kind, event.itemText);
  const { ciphertext, iv } = await encryptChatMessage(payload, chat, userId, privateKeyB64);
  const tempId = `pending-list-${event.eventId}`;
  const pending: StoredMessage = {
    id: tempId,
    chatId: chat.id,
    senderId: userId,
    senderName: username,
    text: payload,
    type: 'list',
    createdAt: Date.now(),
    pending: true,
  };
  await saveMessage(pending);
  onLocalMessage?.(pending);
  await enqueueListEventOutbox(chat.id, tempId, ciphertext, iv, payload, label);
  if (isOnline()) {
    void flushOutbox();
  }
}
