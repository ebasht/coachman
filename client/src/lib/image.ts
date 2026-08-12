function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  return /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(file.name);
}

function mimeFromFile(file: File): string {
  if (file.type) return file.type;
  const name = file.name.toLowerCase();
  if (/\.jpe?g$/.test(name)) return 'image/jpeg';
  if (/\.png$/.test(name)) return 'image/png';
  if (/\.gif$/.test(name)) return 'image/gif';
  if (/\.webp$/.test(name)) return 'image/webp';
  if (/\.heic$/.test(name)) return 'image/heic';
  if (/\.heif$/.test(name)) return 'image/heif';
  if (/\.bmp$/.test(name)) return 'image/bmp';
  return 'application/octet-stream';
}

/** Validate and return the original file — no resize / re-encode, no size limit. */
export async function prepareChatImage(file: File): Promise<File> {
  if (!isImageFile(file)) {
    throw new Error('Выберите изображение');
  }
  if (file.size <= 0) {
    throw new Error('Пустой файл');
  }
  const mime = mimeFromFile(file);
  if (file.type === mime) return file;
  return new File([file], file.name, { type: mime, lastModified: file.lastModified });
}

// Client-side compression: cap the long edge and re-encode to WebP/JPEG.
// Soft byte target keeps outbox/IndexedDB healthy; there is no hard reject.
const MAX_LONG_EDGE = 2560;
const CHAT_TARGET_BYTES = 8 * 1024 * 1024;
const CHAT_QUALITIES = [0.82, 0.72, 0.62, 0.52];

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

export type CompressedImage = { blob: Blob; width: number; height: number };

async function encodeChatCanvas(
  canvas: HTMLCanvasElement,
  preferPng: boolean,
  quality: number,
): Promise<Blob | null> {
  // Prefer lossless PNG only while it stays reasonable; otherwise WebP/JPEG.
  if (preferPng) {
    const png = await canvasToBlob(canvas, 'image/png', quality);
    if (png && png.size <= CHAT_TARGET_BYTES) return png;
  }
  let blob = await canvasToBlob(canvas, 'image/webp', quality);
  if (!blob) {
    blob = await canvasToBlob(canvas, 'image/jpeg', quality);
  }
  return blob;
}

/**
 * Resize + re-encode a picked photo before upload. Applies EXIF orientation,
 * caps the long edge, never upscales, and prefers WebP (JPEG fallback). Large
 * PNGs are kept only while under the soft byte target. On decode failure the
 * caller should fall back to prepareChatImage(). Returned blob.type/size are
 * what must be sent to /uploads/photos/init — no hard size reject.
 */
export async function compressChatImage(file: File): Promise<CompressedImage> {
  if (!isImageFile(file)) {
    throw new Error('Выберите изображение');
  }
  if (file.size <= 0) {
    throw new Error('Пустой файл');
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('Не удалось обработать изображение');
  }

  try {
    const srcW = bitmap.width;
    const srcH = bitmap.height;
    let longEdgeCap = MAX_LONG_EDGE;
    let best: CompressedImage | null = null;
    const preferPng = file.type === 'image/png';

    for (let pass = 0; pass < 3; pass++) {
      const longEdge = Math.max(srcW, srcH);
      const scale = longEdge > longEdgeCap ? longEdgeCap / longEdge : 1; // never upscale
      const w = Math.max(1, Math.round(srcW * scale));
      const h = Math.max(1, Math.round(srcH * scale));

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Не удалось обработать изображение');
      }
      ctx.drawImage(bitmap, 0, 0, w, h);

      for (const quality of CHAT_QUALITIES) {
        const blob = await encodeChatCanvas(canvas, preferPng && pass === 0, quality);
        if (!blob) continue;
        best = { blob, width: w, height: h };
        if (blob.size <= CHAT_TARGET_BYTES) {
          // Don't inflate an already-small photo: if we didn't resize and the
          // re-encode is larger, keep the original bytes.
          const originalUsable =
            file.type === 'image/jpeg' || file.type === 'image/webp' || preferPng;
          if (scale === 1 && originalUsable && blob.size >= file.size) {
            return { blob: file, width: srcW, height: srcH };
          }
          return best;
        }
      }

      longEdgeCap = Math.round(longEdgeCap * 0.75);
    }

    if (!best) {
      throw new Error('Не удалось обработать изображение');
    }
    return best;
  } finally {
    bitmap.close?.();
  }
}

/** Stories: sharp enough on phones, always re-encoded so huge camera files fit easily. */
const STORY_MAX_LONG_EDGE = 1600;
const STORY_TARGET_BYTES = 1_800_000;
const STORY_QUALITIES = [0.85, 0.78, 0.7, 0.62];

/**
 * Compress a photo for a 24h story. Always outputs JPEG (good quality, small),
 * caps the long edge, and steps quality down until under ~1.8 MB.
 */
export async function compressStoryImage(file: File): Promise<CompressedImage> {
  if (!isImageFile(file)) {
    throw new Error('Выберите изображение');
  }
  if (file.size <= 0) {
    throw new Error('Пустой файл');
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('Не удалось обработать изображение');
  }

  try {
    const srcW = bitmap.width;
    const srcH = bitmap.height;
    let longEdgeCap = STORY_MAX_LONG_EDGE;
    let best: CompressedImage | null = null;

    for (let pass = 0; pass < 3; pass++) {
      const longEdge = Math.max(srcW, srcH);
      const scale = longEdge > longEdgeCap ? longEdgeCap / longEdge : 1;
      const w = Math.max(1, Math.round(srcW * scale));
      const h = Math.max(1, Math.round(srcH * scale));

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Не удалось обработать изображение');
      }
      // White backdrop — JPEG has no alpha; avoids black corners from transparent PNG.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bitmap, 0, 0, w, h);

      for (const quality of STORY_QUALITIES) {
        let blob = await canvasToBlob(canvas, 'image/jpeg', quality);
        if (!blob) {
          blob = await canvasToBlob(canvas, 'image/webp', quality);
        }
        if (!blob) continue;
        best = { blob, width: w, height: h };
        if (blob.size <= STORY_TARGET_BYTES) {
          return best;
        }
      }

      // Still too large — shrink further and retry.
      longEdgeCap = Math.round(longEdgeCap * 0.75);
    }

    if (!best) {
      throw new Error('Не удалось обработать изображение');
    }
    return best;
  } finally {
    bitmap.close?.();
  }
}
