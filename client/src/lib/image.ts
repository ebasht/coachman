const INITIAL_MAX_DIMENSION = 1024;
// nginx default client_max_body_size is 1 MB — stay safely below with multipart overhead.
const MAX_TARGET_BYTES = 700 * 1024;

function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  return /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(file.name);
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Не удалось прочитать изображение'));
    img.src = url;
  });
}

async function imageSourceFromFile(file: File): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  cleanup: () => void;
}> {
  if (typeof createImageBitmap !== 'undefined') {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        cleanup: () => bitmap.close(),
      };
    } catch {
      // iOS HEIC and some formats fail here — fall back below.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(url);
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      cleanup: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function fitDimensions(width: number, height: number, maxDimension: number) {
  let w = width;
  let h = height;
  if (w <= maxDimension && h <= maxDimension) return { w, h };
  if (w > h) {
    h = Math.round((h * maxDimension) / w);
    w = maxDimension;
  } else {
    w = Math.round((w * maxDimension) / h);
    h = maxDimension;
  }
  return { w, h };
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Не удалось сжать изображение'))),
      'image/jpeg',
      quality,
    );
  });
}

async function encodeUnderLimit(source: CanvasImageSource, width: number, height: number): Promise<Blob> {
  let maxDim = INITIAL_MAX_DIMENSION;
  let quality = 0.82;

  for (let attempt = 0; attempt < 10; attempt++) {
    const { w, h } = fitDimensions(width, height, maxDim);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Не удалось обработать изображение');
    ctx.drawImage(source, 0, 0, w, h);

    const blob = await canvasToJpeg(canvas, quality);
    if (blob.size <= MAX_TARGET_BYTES) return blob;

    if (quality > 0.5) {
      quality -= 0.1;
      continue;
    }
    maxDim = Math.round(maxDim * 0.85);
    quality = 0.78;
    if (maxDim < 480) break;
  }

  throw new Error('Фото слишком большое. Попробуйте другое изображение.');
}

export async function compressImage(file: File): Promise<File> {
  if (!isImageFile(file)) return file;

  const { source, width, height, cleanup } = await imageSourceFromFile(file);
  try {
    const blob = await encodeUnderLimit(source, width, height);
    const name = file.name.replace(/\.\w+$/, '') || 'photo';
    return new File([blob], `${name}.jpg`, { type: 'image/jpeg' });
  } finally {
    cleanup();
  }
}
