import { api, type RawMessage } from './api';
import { migrateLocalPreview } from './image-preview';
import {
  addOutboxItem,
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

let flushPromise: Promise<number> | null = null;
let defaultAuthRetry: (() => Promise<boolean>) | undefined;

export function setOutboxAuthRetry(fn: (() => Promise<boolean>) | undefined) {
  defaultAuthRetry = fn;
}

function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  return err instanceof Error && /failed|network|timeout|load|abort/i.test(err.message);
}

function isAuthError(err: unknown): boolean {
  return err instanceof Error && /unauthorized|401/i.test(err.message);
}

function isRetryableError(err: unknown): boolean {
  return isNetworkError(err) || isAuthError(err);
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
  if (item.kind === 'text') {
    const msg = await api.sendMessage(item.chatId, {
      ciphertext: item.ciphertext,
      iv: item.iv,
      type: 'text',
    });
    await replacePendingMessage(item.tempMessageId, {
      id: msg.id,
      chatId: msg.chatId,
      senderId: msg.senderId,
      senderName: 'Я',
      text: item.plainText,
      type: 'text',
      createdAt: msg.createdAt,
      pending: false,
    });
    return msg;
  }

  const blob = new Blob([item.imageCiphertext]);
  const { id: imageId } = await api.uploadImage(item.chatId, blob, item.imageIv, item.imageMimeType);
  const msg = await api.sendMessage(item.chatId, {
    ciphertext: item.msgCiphertext,
    iv: item.msgIv,
    type: 'image',
    imageId,
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

async function trySendItem(
  item: OutboxItem,
  onSent?: (msg: RawMessage) => void,
  onAuthRetry?: () => Promise<boolean>,
): Promise<boolean> {
  try {
    const msg = await sendOutboxItem(item);
    await removeOutboxItem(item.id);
    if (msg) onSent?.(msg);
    return true;
  } catch (err) {
    if (isAuthError(err) && onAuthRetry) {
      const refreshed = await onAuthRetry();
      if (refreshed) {
        try {
          const msg = await sendOutboxItem(item);
          await removeOutboxItem(item.id);
          if (msg) onSent?.(msg);
          return true;
        } catch (retryErr) {
          if (!isRetryableError(retryErr)) {
            console.warn('outbox item failed after auth retry', item.id, retryErr);
          }
          return false;
        }
      }
    }
    if (!isRetryableError(err)) {
      console.warn('outbox item failed', item.id, err);
    }
    return false;
  }
}

async function doFlushOutbox(options?: OutboxFlushOptions): Promise<number> {
  const items = await getOutboxItems();
  if (items.length === 0) return 0;

  let sent = 0;
  for (const item of items) {
    const ok = await trySendItem(item, options?.onSent, options?.onAuthRetry);
    if (!ok) break;
    sent++;
  }

  if (sent > 0) {
    window.dispatchEvent(new CustomEvent(OUTBOX_FLUSHED_EVENT, { detail: { sent } }));
  }
  return sent;
}

export function flushOutbox(options?: OutboxFlushOptions): Promise<number> {
  const merged: OutboxFlushOptions = {
    onSent: options?.onSent,
    onAuthRetry: options?.onAuthRetry ?? defaultAuthRetry,
  };
  if (!flushPromise) {
    flushPromise = doFlushOutbox(merged).finally(() => {
      flushPromise = null;
    });
  }
  return flushPromise;
}
