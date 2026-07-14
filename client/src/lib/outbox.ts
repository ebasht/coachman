import { api, type RawMessage } from './api';
import { isOnline } from './network';
import { migrateLocalPreview } from './image-preview';
import { truncatePushBody } from './push-preview';
import {
  addOutboxItem,
  deleteMessageLocal,
  getOutboxItems,
  removeOutboxItem,
  replacePendingMessage,
  saveCachedImage,
  type OutboxItem,
} from './storage';

export const OUTBOX_FLUSHED_EVENT = 'outbox-flushed';

export type OutboxFlushOptions = {
  onSent?: (msg: RawMessage) => void;
  onAuthRetry?: () => Promise<boolean>;
};

let defaultAuthRetry: (() => Promise<boolean>) | undefined;

export function setOutboxAuthRetry(fn: (() => Promise<boolean>) | undefined) {
  defaultAuthRetry = fn;
}

export function isOfflineError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (!(err instanceof Error)) return false;
  const msg = err.message || '';

  // HTTP/API errors must NOT look like "offline" — otherwise one bad outbox
  // item (call/list/system) blocks all later messages forever.
  if (
    /unauthorized|forbidden|internal error|bad request|ciphertext|не удалось|request failed/i.test(
      msg,
    )
  ) {
    return false;
  }

  if (err.name === 'TypeError' || err instanceof TypeError) {
    return /failed to fetch|networkerror|load failed|network request failed/i.test(msg);
  }

  return /failed to fetch|networkerror|network request failed|timeout|превышено время|ожидания ответа|offline|err_network/i.test(
    msg,
  );
}

export function isAuthError(err: unknown): boolean {
  return err instanceof Error && /unauthorized|401|forbidden|403/i.test(err.message);
}

function isRetryableError(err: unknown): boolean {
  return isOfflineError(err) || isAuthError(err);
}

export async function hasOutboxItems(): Promise<boolean> {
  const items = await getOutboxItems();
  return items.length > 0;
}

export async function enqueueTextOutbox(
  chatId: string,
  tempMessageId: string,
  ciphertext: string,
  iv: string,
  plainText: string,
) {
  const existing = await getOutboxItems();
  if (existing.some((item) => item.tempMessageId === tempMessageId)) return;
  await addOutboxItem({
    id: crypto.randomUUID(),
    chatId,
    tempMessageId,
    kind: 'text',
    ciphertext,
    iv,
    plainText,
    createdAt: Date.now(),
  });
}

export async function enqueueCallOutbox(
  chatId: string,
  tempMessageId: string,
  ciphertext: string,
  iv: string,
  plainText: string,
  pushBody: string,
) {
  const existing = await getOutboxItems();
  if (existing.some((item) => item.tempMessageId === tempMessageId)) return;
  await addOutboxItem({
    id: crypto.randomUUID(),
    chatId,
    tempMessageId,
    kind: 'call',
    ciphertext,
    iv,
    plainText,
    pushBody,
    createdAt: Date.now(),
  });
}

export async function enqueueListEventOutbox(
  chatId: string,
  tempMessageId: string,
  ciphertext: string,
  iv: string,
  plainText: string,
  pushBody: string,
) {
  const existing = await getOutboxItems();
  if (existing.some((item) => item.tempMessageId === tempMessageId)) return;
  await addOutboxItem({
    id: crypto.randomUUID(),
    chatId,
    tempMessageId,
    kind: 'list',
    ciphertext,
    iv,
    plainText,
    pushBody,
    createdAt: Date.now(),
  });
}

export async function enqueueImageOutbox(
  chatId: string,
  tempMessageId: string,
  imageCiphertext: ArrayBuffer,
  imageIv: string,
  imageMimeType: string,
  msgCiphertext: string,
  msgIv: string,
  previewData: ArrayBuffer,
  previewMimeType: string,
) {
  const existing = await getOutboxItems();
  if (existing.some((item) => item.tempMessageId === tempMessageId)) return;
  await addOutboxItem({
    id: crypto.randomUUID(),
    chatId,
    tempMessageId,
    kind: 'image',
    imageCiphertext,
    imageIv,
    imageMimeType,
    msgCiphertext,
    msgIv,
    previewData,
    previewMimeType,
    createdAt: Date.now(),
  });
}

async function sendOutboxItem(item: OutboxItem): Promise<RawMessage | null> {
  if (item.kind === 'image') {
    const blob = new Blob([item.imageCiphertext]);
    const { id: imageId } = await api.uploadImage(item.chatId, blob, item.imageIv, item.imageMimeType);
    const msg = await api.sendMessage(item.chatId, {
      ciphertext: item.msgCiphertext,
      iv: item.msgIv,
      type: 'image',
      imageId,
      pushBody: 'Фото',
    });
    await saveCachedImage(imageId, item.previewData, item.previewMimeType);
    await migrateLocalPreview(item.tempMessageId, msg.id, imageId);
    await replacePendingMessage(item.tempMessageId, {
      id: msg.id,
      chatId: msg.chatId,
      senderId: msg.senderId,
      senderName: 'Я',
      text: '📷 Изображение',
      type: 'image',
      imageId,
      createdAt: msg.createdAt,
      pending: false,
    });
    return msg;
  }

  const msgType = item.kind === 'text' ? 'text' : item.kind;
  const msg = await api.sendMessage(item.chatId, {
    ciphertext: item.ciphertext,
    iv: item.iv,
    type: msgType,
    pushBody: truncatePushBody(
      item.kind === 'text' ? item.plainText : (item.pushBody ?? item.plainText),
    ),
  });
  await replacePendingMessage(item.tempMessageId, {
    id: msg.id,
    chatId: msg.chatId,
    senderId: msg.senderId,
    senderName: 'Я',
    text: item.plainText,
    type: msgType,
    createdAt: msg.createdAt,
    pending: false,
  });
  return msg;
}

type SendAttempt = 'sent' | 'retryable' | 'dropped';

async function dropPoisonItem(item: OutboxItem, err: unknown): Promise<void> {
  console.warn('outbox item dropped', item.id, item.kind, err);
  // Item may already be claimed (removed) before send — delete is idempotent.
  try {
    await removeOutboxItem(item.id);
  } catch {
    // ignore
  }
  if (item.kind === 'call' || item.kind === 'list') {
    try {
      await deleteMessageLocal(item.tempMessageId, item.chatId);
    } catch {
      // ignore
    }
  }
}

async function requeueOutboxItem(item: OutboxItem): Promise<void> {
  try {
    await addOutboxItem(item);
  } catch {
    // ignore
  }
}

async function trySendItem(
  item: OutboxItem,
  onSent?: (msg: RawMessage) => void,
  onAuthRetry?: () => Promise<boolean>,
): Promise<SendAttempt> {
  // Claim before network I/O so a concurrent flush cannot send the same item twice.
  await removeOutboxItem(item.id);

  try {
    const msg = await sendOutboxItem(item);
    if (msg) onSent?.(msg);
    return 'sent';
  } catch (err) {
    if (isAuthError(err) && onAuthRetry) {
      const refreshed = await onAuthRetry();
      if (refreshed) {
        try {
          const msg = await sendOutboxItem(item);
          if (msg) onSent?.(msg);
          return 'sent';
        } catch (retryErr) {
          if (isRetryableError(retryErr)) {
            await requeueOutboxItem(item);
            return 'retryable';
          }
          await dropPoisonItem(item, retryErr);
          return 'dropped';
        }
      }
    }
    if (isRetryableError(err)) {
      await requeueOutboxItem(item);
      return 'retryable';
    }
    await dropPoisonItem(item, err);
    return 'dropped';
  }
}

async function flushOutboxOnce(options?: OutboxFlushOptions): Promise<number> {
  const onSent = options?.onSent;
  const onAuthRetry = options?.onAuthRetry ?? defaultAuthRetry;

  const items = await getOutboxItems();
  if (items.length === 0) return 0;

  const sorted = [...items].sort((a, b) => a.createdAt - b.createdAt);
  let sent = 0;
  for (const item of sorted) {
    const result = await trySendItem(item, onSent, onAuthRetry);
    if (result === 'sent') {
      sent++;
      continue;
    }
    if (result === 'dropped') {
      continue;
    }
    // Network / auth: keep user messages ordered, but never let call/list events
    // head-of-line block ordinary text (including links).
    if (item.kind === 'call' || item.kind === 'list') {
      continue;
    }
    break;
  }

  if (sent > 0) {
    window.dispatchEvent(new CustomEvent(OUTBOX_FLUSHED_EVENT, { detail: { sent } }));
  }
  return sent;
}

let flushChain: Promise<unknown> = Promise.resolve();

export async function flushOutbox(options?: OutboxFlushOptions): Promise<number> {
  if (!isOnline()) return 0;

  const run = async () => {
    let total = 0;
    let round = await flushOutboxOnce(options);
    total += round;
    while (round > 0 && (await hasOutboxItems())) {
      round = await flushOutboxOnce(options);
      total += round;
      if (round === 0) break;
    }
    return total;
  };

  const next = flushChain.then(run, run);
  flushChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
