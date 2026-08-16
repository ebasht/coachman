import type { RawMessage } from './api';
import type { StoredMessage } from './storage';

export const PROVISIONAL_ID_PREFIX = 'provisional-';

export function provisionalMessageId(chatId: string): string {
  return `${PROVISIONAL_ID_PREFIX}${chatId}`;
}

export function isProvisionalMessageId(id: string | undefined): boolean {
  return !!id && id.startsWith(PROVISIONAL_ID_PREFIX);
}

export type LivePushFields = {
  chatId: string;
  body?: string;
  title?: string;
  messageId?: string;
  senderId?: string;
  ciphertext?: string;
  iv?: string;
  sequence?: number;
  createdAt?: number;
  msgType?: string;
};

function asString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/** Pull chat + preview + optional ciphertext envelope out of a SW / FCM payload. */
export function parseLivePushFields(data: Record<string, unknown> | null | undefined): LivePushFields | null {
  if (!data) return null;
  const chatId = asString(data.chatId);
  if (!chatId) return null;
  const nested =
    data.notification && typeof data.notification === 'object' && !Array.isArray(data.notification)
      ? (data.notification as Record<string, unknown>)
      : null;
  return {
    chatId,
    body: asString(nested?.body) || asString(data.body) || undefined,
    title: asString(nested?.title) || asString(data.title) || undefined,
    messageId: asString(data.messageId) || undefined,
    senderId: asString(data.senderId) || asString(data.fromUserId) || undefined,
    ciphertext: asString(data.ciphertext) || undefined,
    iv: asString(data.iv) || undefined,
    sequence: asNumber(data.sequence),
    createdAt: asNumber(data.createdAt) || asNumber(data.ts),
    msgType: asString(data.msgType) || asString(data.messageType) || undefined,
  };
}

export function isGenericPushBody(body: string | undefined): boolean {
  const t = (body || '').trim();
  return !t || t === 'Новое сообщение' || t === 'Есть обновления';
}

function guessType(text: string): StoredMessage['type'] {
  if (text === 'Фото' || text.startsWith('📷')) return 'image';
  if (text === 'Видео' || text.startsWith('🎬')) return 'video';
  if (text.startsWith('Добавлено в список') || text === 'Новый пункт в списке') return 'list';
  return 'text';
}

/** Optimistic bubble / list preview from the push body (same text the OS already showed). */
export function buildProvisionalMessage(
  fields: LivePushFields,
  fallbackSenderName = '?',
): StoredMessage | null {
  const text = (fields.body || '').trim();
  if (!text) return null;
  const createdAt = fields.createdAt && fields.createdAt > 0 ? fields.createdAt : Date.now();
  const type = (fields.msgType as StoredMessage['type'] | undefined) || guessType(text);
  return {
    id: fields.messageId || provisionalMessageId(fields.chatId),
    chatId: fields.chatId,
    senderId: fields.senderId || 'unknown',
    senderName: fields.title || fallbackSenderName,
    text,
    type: type === 'image' || type === 'video' || type === 'call' || type === 'list' ? type : 'text',
    sequence: fields.sequence,
    createdAt,
    provisional: true,
  };
}

function asMessageType(value: string | undefined): RawMessage['type'] {
  if (value === 'image' || value === 'video' || value === 'call' || value === 'list') return value;
  return 'text';
}

/** Ciphertext carried in the push so a living page can decrypt without HTTP. */
export function pushEnvelopeToRawMessage(fields: LivePushFields): RawMessage | null {
  if (!fields.ciphertext || !fields.chatId) return null;
  return {
    id: fields.messageId || `push-${fields.chatId}-${fields.createdAt || Date.now()}`,
    chatId: fields.chatId,
    senderId: fields.senderId || '',
    ciphertext: fields.ciphertext,
    iv: fields.iv || '',
    type: asMessageType(fields.msgType),
    sequence: fields.sequence,
    createdAt: fields.createdAt || Date.now(),
  };
}

export function shouldRefreshGroupKeyOnLoad(opts: {
  isGroup: boolean;
  wrapMissing: boolean;
  localEpoch?: number;
  serverEpoch?: number;
}): boolean {
  if (!opts.isGroup) return false;
  if (opts.wrapMissing) return true;
  const server = opts.serverEpoch ?? 1;
  if (opts.localEpoch == null) return false;
  return opts.localEpoch !== server;
}
