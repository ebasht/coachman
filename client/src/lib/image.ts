const MAX_DIMENSION = 1920;
const JPEG_QUALITY = 0.85;

export async function compressImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file;

  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;

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
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Не удалось сжать изображение'))),
      'image/jpeg',
      JPEG_QUALITY
    );
  });

  const name = file.name.replace(/\.\w+$/, '.jpg');
  return new File([blob], name, { type: 'image/jpeg' });
}
