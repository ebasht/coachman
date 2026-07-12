import type { Chat } from './api';
import { encryptChatMessage } from './messages-encrypt';
import { isOnline } from './network';
import { enqueueCallOutbox, flushOutbox } from './outbox';
import { getMessages, saveMessage, type StoredMessage } from './storage';

export type CallEventKind = 'no_answer' | 'rejected' | 'ended' | 'failed';

export type CallEventReport = {
  chatId: string;
  callId: string;
  kind: CallEventKind;
  durationSec?: number;
};

type CallEventPayload = {
  v: 1;
  kind: CallEventKind;
  callId: string;
  durationSec?: number;
};

export function formatCallDuration(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatCallEventLabel(kind: CallEventKind, durationSec?: number): string {
  switch (kind) {
    case 'rejected':
      return 'Отклонённый видеозвонок';
    case 'no_answer':
      return 'Видеозвонок без ответа';
    case 'failed':
      return 'Видеозвонок не состоялся';
    case 'ended':
      return `Видеозвонок · ${formatCallDuration(durationSec ?? 0)}`;
    default:
      return 'Видеозвонок';
  }
}

export function encodeCallEventPayload(ev: CallEventReport): string {
  const payload: CallEventPayload = {
    v: 1,
    kind: ev.kind,
    callId: ev.callId,
  };
  if (ev.kind === 'ended' && ev.durationSec != null) {
    payload.durationSec = Math.max(0, Math.floor(ev.durationSec));
  }
  return JSON.stringify(payload);
}

export function parseCallEventPayload(text: string): CallEventPayload | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const data = JSON.parse(trimmed) as Partial<CallEventPayload>;
    if (data.v !== 1 || typeof data.callId !== 'string' || typeof data.kind !== 'string') {
      return null;
    }
    if (
      data.kind !== 'no_answer' &&
      data.kind !== 'rejected' &&
      data.kind !== 'ended' &&
      data.kind !== 'failed'
    ) {
      return null;
    }
    return {
      v: 1,
      kind: data.kind,
      callId: data.callId,
      durationSec: typeof data.durationSec === 'number' ? data.durationSec : undefined,
    };
  } catch {
    return null;
  }
}

export function callEventDisplayText(text: string): string {
  const parsed = parseCallEventPayload(text);
  if (!parsed) return text || 'Видеозвонок';
  return formatCallEventLabel(parsed.kind, parsed.durationSec);
}

function messageMentionsCallId(msg: StoredMessage, callId: string): boolean {
  if (msg.type !== 'call') return false;
  if (msg.text.includes(callId)) return true;
  const parsed = parseCallEventPayload(msg.text);
  return parsed?.callId === callId;
}

/** Persist + queue an encrypted call event once per callId. */
export async function postCallEventMessage(opts: {
  event: CallEventReport;
  chat: Chat;
  userId: string;
  username: string;
  privateKeyB64: string;
  onLocalMessage?: (msg: StoredMessage) => void;
}): Promise<void> {
  const { event, chat, userId, username, privateKeyB64, onLocalMessage } = opts;
  const existing = await getMessages(event.chatId);
  if (existing.some((m) => messageMentionsCallId(m, event.callId))) {
    return;
  }

  const payload = encodeCallEventPayload(event);
  const label = formatCallEventLabel(event.kind, event.durationSec);
  const { ciphertext, iv } = await encryptChatMessage(payload, chat, userId, privateKeyB64);
  const tempId = `pending-call-${event.callId}`;
  const pending: StoredMessage = {
    id: tempId,
    chatId: chat.id,
    senderId: userId,
    senderName: username,
    text: payload,
    type: 'call',
    createdAt: Date.now(),
    pending: true,
  };
  await saveMessage(pending);
  onLocalMessage?.(pending);
  await enqueueCallOutbox(chat.id, tempId, ciphertext, iv, payload, label);
  if (isOnline()) {
    void flushOutbox();
  }
}
