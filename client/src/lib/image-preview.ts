import { getCachedImage, saveCachedImage, type StoredMessage } from './storage';

export function localPreviewKey(messageId: string): string {
  return `local:${messageId}`;
}

export async function persistLocalPreview(
  messageId: string,
  data: ArrayBuffer,
  mimeType: string,
): Promise<void> {
  await saveCachedImage(localPreviewKey(messageId), data, mimeType);
}

export async function migrateLocalPreview(
  fromMessageId: string,
  toMessageId: string,
  imageId?: string,
): Promise<void> {
  const cached = await getCachedImage(localPreviewKey(fromMessageId));
  if (!cached) return;
  await persistLocalPreview(toMessageId, cached.data, cached.mimeType);
  if (imageId) {
    await saveCachedImage(imageId, cached.data, cached.mimeType);
  }
}

export async function messageImageUrl(msg: Pick<StoredMessage, 'id' | 'type' | 'imageId'>): Promise<string | undefined> {
  if (msg.type !== 'image') return undefined;

  if (msg.imageId) {
    const byId = await getCachedImage(msg.imageId);
    if (byId) {
      return URL.createObjectURL(new Blob([byId.data], { type: byId.mimeType }));
    }
  }

  const local = await getCachedImage(localPreviewKey(msg.id));
  if (!local) return undefined;
  return URL.createObjectURL(new Blob([local.data], { type: local.mimeType }));
}

export async function hydrateStoredMessages(messages: StoredMessage[]): Promise<StoredMessage[]> {
  return Promise.all(
    messages.map(async (msg) => {
      if (msg.type !== 'image') return msg;
      const imageUrl = await messageImageUrl(msg);
      return imageUrl ? { ...msg, imageUrl } : { ...msg, imageUrl: undefined };
    }),
  );
}
