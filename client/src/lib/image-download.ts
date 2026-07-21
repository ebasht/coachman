import { fetchArrayBufferWithProgress } from './api';
import { base64ToArrayBuffer } from './crypto';
import { clearTransferProgress, setTransferProgress } from './transfer-progress';

async function sleep(ms: number) {
  await new Promise((r) => window.setTimeout(r, ms));
}

/** Same-origin download when CDN presigned GET fails (bucket CORS). */
export async function fetchImageBytesViaApi(
  imageId: string,
  progressKey: string,
): Promise<ArrayBuffer> {
  const { api } = await import('./api');
  setTransferProgress(progressKey, 10, 'download');
  const bytes = await api.fetchImageBytes(imageId, (percent) =>
    setTransferProgress(progressKey, Math.max(10, percent), 'download'),
  );
  setTransferProgress(progressKey, 100, 'download');
  return bytes;
}

/** Fetch image bytes with short retries (CDN object may lag right after upload). */
export async function loadImageBytes(
  imageId: string,
  progressKey?: string,
): Promise<{ bytes: ArrayBuffer; mimeType: string; iv: string }> {
  const { api } = await import('./api');
  let lastErr: unknown;
  const key = progressKey || `img:${imageId}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (attempt === 0) setTransferProgress(key, 0, 'download');
      const img = await api.getImage(imageId);
      let bytes: ArrayBuffer;
      if (img.url) {
        try {
          bytes = await fetchArrayBufferWithProgress(img.url, (percent) =>
            setTransferProgress(key, percent, 'download'),
          );
        } catch {
          // Presigned CDN URL often blocks cross-origin fetch — proxy through /api.
          bytes = await fetchImageBytesViaApi(imageId, key);
        }
      } else if (img.ciphertext) {
        setTransferProgress(key, 50, 'download');
        bytes = base64ToArrayBuffer(img.ciphertext);
        setTransferProgress(key, 100, 'download');
      } else {
        throw new Error('empty image payload');
      }
      if (!bytes.byteLength) throw new Error('empty image bytes');
      clearTransferProgress(key);
      return { bytes, mimeType: img.mimeType, iv: img.iv };
    } catch (err) {
      lastErr = err;
      await sleep(200 * (attempt + 1));
    }
  }
  clearTransferProgress(key);
  throw lastErr instanceof Error ? lastErr : new Error('image load failed');
}
