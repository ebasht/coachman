import { getCachedImage, saveCachedImage, type StoredMessage } from './storage';
import { resolveVideoPosterUrl } from './video-preview';
import { ensureAuthTokenReady } from './api';

export function localPreviewKey(messageId: string): string {
  return `local:${messageId}`;
}

/** Same-origin progressive image URL for Android WebView/PWA. */
export async function resolveImageStreamUrl(imageId: string): Promise<string | undefined> {
  if (!imageId) return undefined;
  const token = await ensureAuthTokenReady();
  if (!token) return undefined;
  return `/api/images/${encodeURIComponent(imageId)}/stream?access_token=${encodeURIComponent(token)}`;
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
  const bare = fromMessageId.replace(/^pending-/, '');
  const candidates = Array.from(
    new Set([fromMessageId, bare, `pending-${bare}`].filter(Boolean)),
  );

  let cached: Awaited<ReturnType<typeof getCachedImage>> | undefined;
  for (const id of candidates) {
    cached = await getCachedImage(localPreviewKey(id));
    if (cached) break;
  }
  if (!cached) return;
  await persistLocalPreview(toMessageId, cached.data, cached.mimeType);
  if (imageId) {
    await saveCachedImage(imageId, cached.data, cached.mimeType);
  }
}

export async function messageImageUrl(
  msg: Pick<StoredMessage, 'id' | 'type' | 'imageId'>,
): Promise<string | undefined> {
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

/**
 * Cache-only display URLs. Must not touch the network — stream / photo bytes
 * belong in {@link enqueueMediaHydrate} so history/text stay unblocked.
 */
export async function hydrateStoredMessages(messages: StoredMessage[]): Promise<StoredMessage[]> {
  return Promise.all(
    messages.map(async (msg) => {
      if (msg.type === 'video') {
        const posterUrl = await resolveVideoPosterUrl(msg);
        return {
          ...msg,
          posterUrl: posterUrl || undefined,
        };
      }
      if (msg.type !== 'image') return msg;
      const imageUrl = await messageImageUrl(msg);
      return imageUrl ? { ...msg, imageUrl } : { ...msg, imageUrl: undefined };
    }),
  );
}
