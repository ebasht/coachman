const MAX_DIMENSION = 1920;
const JPEG_QUALITY = 0.85;

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

export async function compressImage(file: File): Promise<File> {
  if (!isImageFile(file)) return file;

  const { source, width, height, cleanup } = await imageSourceFromFile(file);
  try {
    let w = width;
    let h = height;
    if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
      if (w > h) {
        h = Math.round((h * MAX_DIMENSION) / w);
        w = MAX_DIMENSION;
      } else {
        w = Math.round((w * MAX_DIMENSION) / h);
        h = MAX_DIMENSION;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Не удалось обработать изображение');
    ctx.drawImage(source, 0, 0, w, h);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Не удалось сжать изображение'))),
        'image/jpeg',
        JPEG_QUALITY,
      );
    });

    const name = file.name.replace(/\.\w+$/, '') || 'photo';
    return new File([blob], `${name}.jpg`, { type: 'image/jpeg' });
  } finally {
    cleanup();
  }
}
