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

// Client-side compression targets: cap the long edge and re-encode to WebP/JPEG.
const MAX_LONG_EDGE = 2560;
const ENCODE_QUALITY = 0.82;

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

export type CompressedImage = { blob: Blob; width: number; height: number };

/**
 * Resize + re-encode a picked photo before upload. Applies EXIF orientation,
 * caps the long edge, never upscales, keeps PNG (possible alpha) as PNG, and
 * otherwise prefers WebP (JPEG fallback). On decode failure the caller should
 * fall back to prepareChatImage(). The returned blob.type/blob.size are what
 * must be sent to /uploads/photos/init.
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
    const longEdge = Math.max(srcW, srcH);
    const scale = longEdge > MAX_LONG_EDGE ? MAX_LONG_EDGE / longEdge : 1; // never upscale
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

    // PNG may carry transparency — keep it lossless; everything else → WebP/JPEG.
    const keepPng = file.type === 'image/png';
    let type = keepPng ? 'image/png' : 'image/webp';
    let blob = await canvasToBlob(canvas, type, ENCODE_QUALITY);
    if (!blob && type === 'image/webp') {
      type = 'image/jpeg';
      blob = await canvasToBlob(canvas, type, ENCODE_QUALITY);
    }
    if (!blob) {
      throw new Error('Не удалось обработать изображение');
    }

    // Don't inflate an already-small photo: if we didn't resize and the re-encode
    // is larger, keep the original bytes.
    const originalUsable =
      file.type === 'image/jpeg' || file.type === 'image/webp' || keepPng;
    if (scale === 1 && originalUsable && blob.size >= file.size) {
      return { blob: file, width: srcW, height: srcH };
    }
    return { blob, width: w, height: h };
  } finally {
    bitmap.close?.();
  }
}
