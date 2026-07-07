const PBKDF2_ITERATIONS = 310_000;

function b64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromB64(b64str: string): Uint8Array {
  const bin = atob(b64str);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export interface EncryptedSecret {
  salt: string;
  iv: string;
  ciphertext: string;
}

export async function encryptSecret(plaintext: string, passphrase: string): Promise<EncryptedSecret> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { salt: b64(toArrayBuffer(salt)), iv: b64(toArrayBuffer(iv)), ciphertext: b64(cipher) };
}

export async function decryptSecret(encrypted: EncryptedSecret, passphrase: string): Promise<string> {
  const key = await deriveKey(passphrase, fromB64(encrypted.salt));
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(fromB64(encrypted.iv)) },
    key,
    toArrayBuffer(fromB64(encrypted.ciphertext)),
  );
  return new TextDecoder().decode(plain);
}
