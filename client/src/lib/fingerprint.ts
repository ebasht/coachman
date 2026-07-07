function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function publicKeyFingerprint(publicKeyB64: string): Promise<string> {
  const bytes = b64ToBytes(publicKeyB64);
  const hash = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  const hex = Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 30).match(/.{1,5}/g)!.join(' ').toUpperCase();
}
