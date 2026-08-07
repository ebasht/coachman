/** Capture a JPEG poster frame from a video Blob or URL for chat thumbnails. */

const POSTER_TIMEOUT_MS = 12_000;
const POSTER_MAX_EDGE = 720;
const POSTER_QUALITY = 0.82;

export type VideoPoster = {
  data: ArrayBuffer;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
};

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<VideoPoster> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('poster encode failed'));
          return;
        }
        void blob.arrayBuffer().then((data) => {
          resolve({
            data,
            mimeType: 'image/jpeg',
            width: canvas.width,
            height: canvas.height,
          });
        }, reject);
      },
      'image/jpeg',
      POSTER_QUALITY,
    );
  });
}

function drawVideoFrame(video: HTMLVideoElement): HTMLCanvasElement {
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  const scale = Math.min(1, POSTER_MAX_EDGE / Math.max(vw, vh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(vw * scale));
  canvas.height = Math.max(1, Math.round(vh * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function seekVideo(video: HTMLVideoElement, timeSec: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('seek failed'));
    };
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    try {
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      const t = dur > 0 ? Math.min(timeSec, Math.max(0, dur * 0.05)) : timeSec;
      if (Math.abs(video.currentTime - t) < 0.05) {
        cleanup();
        resolve();
        return;
      }
      video.currentTime = t;
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

/**
 * Best-effort poster from a local File/Blob (sender) or remote stream URL (recipient).
 * Cross-origin streams without CORS may fail canvas export — caller should ignore errors.
 */
export async function captureVideoPoster(source: Blob | string): Promise<VideoPoster> {
  const objectUrl = typeof source === 'string' ? null : URL.createObjectURL(source);
  const src = typeof source === 'string' ? source : objectUrl!;

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  // Same-origin / blob URLs don't need CORS; only set for third-party hosts.
  if (typeof source === 'string' && /^https?:\/\//i.test(source)) {
    try {
      const u = new URL(source, window.location.href);
      if (u.origin !== window.location.origin) {
        video.crossOrigin = 'anonymous';
      }
    } catch {
      /* ignore */
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('poster timeout')), POSTER_TIMEOUT_MS);
      const ok = () => {
        window.clearTimeout(timer);
        resolve();
      };
      const fail = () => {
        window.clearTimeout(timer);
        reject(new Error('poster load failed'));
      };
      video.addEventListener('loadeddata', ok, { once: true });
      video.addEventListener('error', fail, { once: true });
      video.src = src;
      video.load();
    });

    // Prefer a frame slightly into the clip — first frame is often black.
    try {
      await seekVideo(video, 0.25);
    } catch {
      /* keep current frame */
    }

    if (!video.videoWidth || !video.videoHeight) {
      throw new Error('empty video frame');
    }
    return await canvasToJpeg(drawVideoFrame(video));
  } finally {
    video.removeAttribute('src');
    video.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}
