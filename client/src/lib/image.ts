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
