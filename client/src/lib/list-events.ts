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
};

type ListEventPayload = {
  v: 1;
  kind: ListEventKind;
  eventId: string;
};

export function formatListEventLabel(kind: ListEventKind): string {
  switch (kind) {
    case 'item_add':
      return 'Добавлен пункт в список';
    case 'item_done':
      return 'Пункт отмечен выполненным';
    case 'item_undone':
      return 'С пункта снята отметка';
    case 'item_delete':
      return 'Пункт удалён из списка';
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
    return { v: 1, kind: data.kind, eventId: data.eventId };
  } catch {
    return null;
  }
}

export function listEventDisplayText(text: string): string {
  const parsed = parseListEventPayload(text);
  if (!parsed) return text || 'Список обновлён';
  return formatListEventLabel(parsed.kind);
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
  const label = formatListEventLabel(event.kind);
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
