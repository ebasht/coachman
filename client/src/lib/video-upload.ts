import { api, putToPresignedUrl, type UploadProgressFn } from './api';

export type VideoUploadResult = {
  attachmentId: string;
  width: number;
  height: number;
  size: number;
  contentType: string;
  url: string;
};

export type VideoUploadOptions = {
  chatId: string;
  blob: Blob;
  fileName?: string;
  width?: number;
  height?: number;
  onProgress?: UploadProgressFn;
  signal?: AbortSignal;
};

const VIDEO_DIM_TIMEOUT_MS = 8_000;

/** Best-effort width/height from a local video blob (metadata only). */
export async function probeVideoDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  try {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    const dims = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('video metadata timeout')), VIDEO_DIM_TIMEOUT_MS);
      video.onloadedmetadata = () => {
        window.clearTimeout(timer);
        resolve({
          width: Math.round(video.videoWidth) || 0,
          height: Math.round(video.videoHeight) || 0,
        });
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('video metadata failed'));
      };
      video.src = url;
    });
    return dims;
  } catch {
    return { width: 0, height: 0 };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Direct browser → object storage upload for chat videos:
 *   1. init → presigned PUT
 *   2. PUT bytes to storage
 *   3. complete → server HeadObject + attachment row
 */
export async function uploadVideo(opts: VideoUploadOptions): Promise<VideoUploadResult> {
  const { chatId, blob, fileName, onProgress, signal } = opts;
  const contentType = blob.type || 'video/mp4';

  let width = opts.width ?? 0;
  let height = opts.height ?? 0;
  if (!width || !height) {
    const dims = await probeVideoDimensions(blob);
    width = dims.width;
    height = dims.height;
  }

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const init = await api.initVideoUpload(chatId, {
    contentType,
    size: blob.size,
    ...(fileName ? { fileName } : {}),
  });

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  await putToPresignedUrl(init.uploadUrl, blob, contentType, onProgress, signal);

  const done = await api.completeVideoUpload({ uploadId: init.uploadId, width, height });
  return {
    attachmentId: done.attachmentId,
    width: done.width,
    height: done.height,
    size: done.size,
    contentType: done.contentType,
    url: done.url,
  };
}
