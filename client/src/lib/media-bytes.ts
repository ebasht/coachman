/** True when bytes look like a photo/video container, not AES-GCM ciphertext. */
export function looksLikeMediaBytes(data: ArrayBuffer | Uint8Array | null | undefined): boolean {
  if (!data) return false;
  const b = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (b.byteLength < 12) return false;

  // JPEG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;
  // GIF
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return true;
  // WEBP: RIFF....WEBP
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return true;
  }
  // ISO BMFF (MP4 / MOV / AVIF / HEIC): ....ftyp
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return true;
  // WebM / Matroska
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true;
  return false;
}

export function isPlainMediaIv(iv: string | null | undefined): boolean {
  return !iv || iv === 'plain' || iv === 'plain-v1';
}
