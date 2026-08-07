/**
 * Web Share Target: pending photos stashed by the service worker in Cache Storage.
 * Page reads them after landing on /?share=1.
 */

const PENDING_SHARE_CACHE = 'coachman-pending-share';
const META_URL = '/__coachman_pending_share/meta';
const fileUrl = (i: number) => `/__coachman_pending_share/file/${i}`;

export interface PendingShareMeta {
  count: number;
  title?: string;
  text?: string;
  savedAt: number;
  files: Array<{ name: string; type: string }>;
}

export async function loadPendingShareFiles(): Promise<File[]> {
  try {
    const cache = await caches.open(PENDING_SHARE_CACHE);
    const metaRes = await cache.match(META_URL);
    if (!metaRes) return [];
    const meta = (await metaRes.json()) as PendingShareMeta;
    if (!meta?.count || !Array.isArray(meta.files)) return [];

    const out: File[] = [];
    for (let i = 0; i < meta.count; i++) {
      const res = await cache.match(fileUrl(i));
      if (!res) continue;
      const blob = await res.blob();
      if (!blob.size) continue;
      const info = meta.files[i];
      const type = info?.type || blob.type || 'image/jpeg';
      const name = info?.name || `photo-${i + 1}.jpg`;
      out.push(new File([blob], name, { type, lastModified: meta.savedAt || Date.now() }));
    }
    return out;
  } catch {
    return [];
  }
}

export async function clearPendingShare(): Promise<void> {
  try {
    await caches.delete(PENDING_SHARE_CACHE);
  } catch {
    // ignore
  }
}

export function isImageShareFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  return /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(file.name);
}
