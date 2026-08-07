import { ensureAuthTokenReady } from './api';
import { getCachedImage, saveCachedImage, type StoredMessage } from './storage';
import { localPreviewKey } from './image-preview';
import { captureVideoPoster } from './video-poster';

export function videoPosterKey(messageId: string): string {
  return `poster:${messageId}`;
}

export function videoPosterImageKey(imageId: string): string {
  return `poster:img:${imageId}`;
}

export async function persistVideoPoster(
  messageId: string,
  data: ArrayBuffer,
  mimeType = 'image/jpeg',
  imageId?: string,
): Promise<void> {
  await saveCachedImage(videoPosterKey(messageId), data, mimeType);
  if (imageId) {
    await saveCachedImage(videoPosterImageKey(imageId), data, mimeType);
  }
}

export async function migrateVideoPoster(
  fromMessageId: string,
  toMessageId: string,
  imageId?: string,
): Promise<void> {
  const cached =
    (await getCachedImage(videoPosterKey(fromMessageId))) ||
    (await getCachedImage(localPreviewKey(fromMessageId)));
  if (!cached) return;
  // Only migrate image posters — not full video blobs stored as local preview.
  if (cached.mimeType.startsWith('video/')) return;
  await persistVideoPoster(toMessageId, cached.data, cached.mimeType, imageId);
}

export async function resolveVideoPosterUrl(
  msg: Pick<StoredMessage, 'id' | 'type' | 'imageId'>,
): Promise<string | undefined> {
  if (msg.type !== 'video') return undefined;

  if (msg.imageId) {
    const byImg = await getCachedImage(videoPosterImageKey(msg.imageId));
    if (byImg && !byImg.mimeType.startsWith('video/')) {
      return URL.createObjectURL(new Blob([byImg.data], { type: byImg.mimeType }));
    }
  }

  const byMsg = await getCachedImage(videoPosterKey(msg.id));
  if (byMsg && !byMsg.mimeType.startsWith('video/')) {
    return URL.createObjectURL(new Blob([byMsg.data], { type: byMsg.mimeType }));
  }

  // Pending: local preview may already be a JPEG poster.
  const local = await getCachedImage(localPreviewKey(msg.id));
  if (local && local.mimeType.startsWith('image/')) {
    return URL.createObjectURL(new Blob([local.data], { type: local.mimeType }));
  }

  return undefined;
}

/**
 * Same-origin stream URL so <video> works in Capacitor/WebView without depending
 * on S3 CORS. Uses ?access_token= because media elements cannot set Authorization.
 */
export async function resolveVideoPlaybackUrl(
  msg: Pick<StoredMessage, 'id' | 'type' | 'imageId'>,
): Promise<string | undefined> {
  if (msg.type !== 'video') return undefined;

  if (msg.imageId) {
    const token = await ensureAuthTokenReady();
    if (token) {
      return `/api/images/${encodeURIComponent(msg.imageId)}/stream?access_token=${encodeURIComponent(token)}`;
    }
  }

  const local = await getCachedImage(localPreviewKey(msg.id));
  // Local preview for video must be actual video bytes (pending send), not a JPEG poster.
  if (local?.data?.byteLength && local.mimeType.startsWith('video/')) {
    return URL.createObjectURL(new Blob([local.data], { type: local.mimeType || 'video/mp4' }));
  }
  return undefined;
}

/** Build poster from playback URL and cache it (best-effort). */
export async function ensureVideoPoster(
  msg: Pick<StoredMessage, 'id' | 'type' | 'imageId'>,
  playbackUrl?: string,
): Promise<string | undefined> {
  if (msg.type !== 'video') return undefined;
  const existing = await resolveVideoPosterUrl(msg);
  if (existing) return existing;

  const src = playbackUrl || (await resolveVideoPlaybackUrl(msg));
  if (!src) return undefined;

  try {
    const poster = await captureVideoPoster(src);
    await persistVideoPoster(msg.id, poster.data, poster.mimeType, msg.imageId);
    return URL.createObjectURL(new Blob([poster.data], { type: poster.mimeType }));
  } catch {
    return undefined;
  }
}
