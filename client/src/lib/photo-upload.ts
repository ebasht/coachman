import { api, putToPresignedUrl, type UploadProgressFn } from './api';

export type PhotoUploadResult = {
  attachmentId: string;
  width: number;
  height: number;
  size: number;
  contentType: string;
  url: string;
};

export type PhotoUploadOptions = {
  chatId: string;
  blob: Blob;
  fileName?: string;
  /** Pixel dimensions if already known (e.g. from client compression). */
  width?: number;
  height?: number;
  onProgress?: UploadProgressFn;
  signal?: AbortSignal;
};

/**
 * Direct browser → Yandex Object Storage upload:
 *   1. init  — exchange metadata for a presigned PUT URL,
 *   2. PUT   — upload bytes straight to object storage (never through nginx/Go),
 *   3. complete — server HeadObject-verifies and records the attachment.
 * Supports progress and cancellation via AbortSignal.
 */
export async function uploadPhoto(opts: PhotoUploadOptions): Promise<PhotoUploadResult> {
  const { chatId, blob, fileName, onProgress, signal } = opts;
  const contentType = blob.type || 'image/jpeg';

  let width = opts.width ?? 0;
  let height = opts.height ?? 0;
  if (!width || !height) {
    try {
      const bmp = await createImageBitmap(blob);
      width = bmp.width;
      height = bmp.height;
      bmp.close?.();
    } catch {
      // Dimensions are optional metadata — proceed without them.
    }
  }

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const init = await api.initPhotoUpload(chatId, {
    contentType,
    size: blob.size,
    ...(fileName ? { fileName } : {}),
  });

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  await putToPresignedUrl(init.uploadUrl, blob, contentType, onProgress, signal);

  const done = await api.completePhotoUpload({ uploadId: init.uploadId, width, height });
  return {
    attachmentId: done.attachmentId,
    width: done.width,
    height: done.height,
    size: done.size,
    contentType: done.contentType,
    url: done.url,
  };
}
