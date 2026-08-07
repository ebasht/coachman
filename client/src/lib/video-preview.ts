import { api } from './api';
import { getCachedImage, type StoredMessage } from './storage';
import { localPreviewKey } from './image-preview';

/** Resolve a playable URL for a chat video (local preview or short-lived CDN/presigned GET). */
export async function resolveVideoPlaybackUrl(
  msg: Pick<StoredMessage, 'id' | 'type' | 'imageId'>,
): Promise<string | undefined> {
  if (msg.type !== 'video') return undefined;

  if (msg.imageId) {
    try {
      const meta = await api.getImage(msg.imageId);
      if (meta.url) return meta.url;
    } catch {
      /* fall through to local preview */
    }
  }

  const local = await getCachedImage(localPreviewKey(msg.id));
  if (!local) return undefined;
  return URL.createObjectURL(new Blob([local.data], { type: local.mimeType }));
}
