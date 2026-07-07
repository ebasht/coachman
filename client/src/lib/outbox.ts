import { api, type RawMessage } from './api';
import {
  addOutboxItem,
  getOutboxItems,
  removeOutboxItem,
  replacePendingMessage,
  type OutboxItem,
} from './storage';

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
  const { saveCachedImage } = await import('./storage');
  await saveCachedImage(imageId, item.previewData, item.previewMimeType);
  await replacePendingMessage(item.tempMessageId, {
    id: msg.id,
    chatId: msg.chatId,
    senderId: msg.senderId,
    senderName: 'Я',
    text: '📷 Изображение',
    type: 'image',
    imageId,
    imageUrl: URL.createObjectURL(new Blob([item.previewData], { type: item.previewMimeType })),
    createdAt: msg.createdAt,
    pending: false,
  });
  return msg;
}

export async function flushOutbox(onSent?: (msg: RawMessage) => void): Promise<number> {
  if (!navigator.onLine) return 0;

  const items = await getOutboxItems();
  let sent = 0;
  for (const item of items) {
    try {
      const msg = await sendOutboxItem(item);
      await removeOutboxItem(item.id);
      if (msg) onSent?.(msg);
      sent++;
    } catch {
      break;
    }
  }
  return sent;
}
