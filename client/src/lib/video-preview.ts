import { ensureAuthTokenReady } from './api';
import { getCachedImage, type StoredMessage } from './storage';
import { localPreviewKey } from './image-preview';

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
  if (!local) return undefined;
  return URL.createObjectURL(new Blob([local.data], { type: local.mimeType || 'video/mp4' }));
}
