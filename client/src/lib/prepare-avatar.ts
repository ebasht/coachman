const MAX_SIZE = 256;
const JPEG_QUALITY = 0.85;

export async function prepareAvatarFile(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Выберите изображение');
  }

  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_SIZE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Не удалось обработать изображение');
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY);
    });
    if (!blob) throw new Error('Не удалось обработать изображение');
    return blob;
  } finally {
    bitmap.close();
  }
}
