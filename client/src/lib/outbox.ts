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

function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof Error && /failed|network|timeout|load/i.test(err.message));
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

export async function flushOutbox(onSent?: (msg: RawMessage) => void): Promise<number> {
  const items = await getOutboxItems();
  if (items.length === 0) return 0;

  let sent = 0;
  for (const item of items) {
    try {
      const msg = await sendOutboxItem(item);
      await removeOutboxItem(item.id);
      if (msg) onSent?.(msg);
      sent++;
    } catch (err) {
      if (!isNetworkError(err)) {
        console.warn('outbox item failed', item.id, err);
      }
      break;
    }
  }

  if (sent > 0) {
    window.dispatchEvent(new CustomEvent(OUTBOX_FLUSHED_EVENT, { detail: { sent } }));
  }
  return sent;
}
