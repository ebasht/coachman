import {
  encryptDirectMessage,
  decryptDirectMessage,
  encryptWithKey,
  decryptWithKey,
  importPublicKey,
  arrayBufferToBase64,
  base64ToArrayBuffer,
} from './crypto';

export interface RecoveryKeyBundle {
  v: 1;
  privateKey: string;
  signingPrivateKey: string;
  signingPublicKey: string;
}

function bytesToB64Url(bytes: Uint8Array): string {
  const copy = bytes.slice();
  return arrayBufferToBase64(copy.buffer)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64UrlToBytes(b64url: string): Uint8Array {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return new Uint8Array(base64ToArrayBuffer(padded + pad));
}

function toBufferSource(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function buildRecoveryLink(token: string, keyB64Url: string): string {
  const url = new URL(window.location.origin);
  url.searchParams.set('recover', token);
  url.searchParams.set('k', keyB64Url);
  return url.toString();
}

export function parseRecoveryParams(text: string): { token: string; key: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed, window.location.origin);
    const token = url.searchParams.get('recover');
    const key = url.searchParams.get('k');
    if (token && key) return { token, key };
  } catch {
    // not a URL
  }
  const tokenMatch = trimmed.match(/[?&]recover=([^&\s#]+)/i);
  const keyMatch = trimmed.match(/[?&]k=([^&\s#]+)/i);
  if (tokenMatch?.[1] && keyMatch?.[1]) {
    return {
      token: decodeURIComponent(tokenMatch[1]),
      key: decodeURIComponent(keyMatch[1]),
    };
  }
  return null;
}

/** Encrypt identity keys to the admin ECDH public key (opaque server escrow). */
export async function encryptKeyBackupForAdmin(
  bundle: RecoveryKeyBundle,
  adminPublicKeyB64: string,
): Promise<string> {
  const adminPub = await importPublicKey(adminPublicKeyB64);
  const { ciphertext } = await encryptDirectMessage(JSON.stringify(bundle), adminPub);
  return ciphertext;
}

/** Admin decrypts escrow with their ECDH private key. */
export async function decryptKeyBackupAsAdmin(
  envelope: string,
  adminPrivateKey: CryptoKey,
  adminPublicKeyB64: string,
): Promise<RecoveryKeyBundle> {
  const adminPub = await importPublicKey(adminPublicKeyB64);
  const plain = await decryptDirectMessage(envelope, '', adminPrivateKey, adminPub);
  const parsed = JSON.parse(plain) as RecoveryKeyBundle;
  if (parsed?.v !== 1 || !parsed.privateKey || !parsed.signingPrivateKey) {
    throw new Error('invalid key backup');
  }
  return parsed;
}

/** Wrap keys for a one-time recovery QR (AES key travels in the link). */
export async function wrapRecoveryBundle(
  bundle: RecoveryKeyBundle,
): Promise<{ ciphertext: string; keyB64Url: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const aesKey = await crypto.subtle.importKey(
    'raw',
    toBufferSource(raw),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const { ciphertext, iv } = await encryptWithKey(JSON.stringify(bundle), aesKey);
  return {
    ciphertext: JSON.stringify({ v: 1, ciphertext, iv }),
    keyB64Url: bytesToB64Url(raw),
  };
}

export async function unwrapRecoveryBundle(
  wrapped: string,
  keyB64Url: string,
): Promise<RecoveryKeyBundle> {
  const env = JSON.parse(wrapped) as { v: number; ciphertext: string; iv: string };
  if (env?.v !== 1 || !env.ciphertext || !env.iv) {
    throw new Error('invalid recovery payload');
  }
  const raw = b64UrlToBytes(keyB64Url);
  const aesKey = await crypto.subtle.importKey(
    'raw',
    toBufferSource(raw),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const plain = await decryptWithKey(env.ciphertext, env.iv, aesKey);
  const parsed = JSON.parse(plain) as RecoveryKeyBundle;
  if (parsed?.v !== 1 || !parsed.privateKey || !parsed.signingPrivateKey) {
    throw new Error('invalid recovery payload');
  }
  return parsed;
}
