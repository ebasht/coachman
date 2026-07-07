const ALGO = { name: 'ECDH', namedCurve: 'P-256' } as const;
const SIGN_ALGO = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const AES = { name: 'AES-GCM', length: 256 } as const;

function bytesToB64(bytes: Uint8Array): string {
  const chunkSize = 8192;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    chunks.push(String.fromCharCode(...slice));
  }
  return btoa(chunks.join(''));
}

function bufToB64(buf: ArrayBuffer): string {
  return bytesToB64(new Uint8Array(buf));
}

function b64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ALGO, true, ['deriveKey', 'deriveBits']);
}

export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return bufToB64(raw);
}

export async function importPublicKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64ToBuf(b64), ALGO, true, []);
}

export async function exportPrivateKey(key: CryptoKey): Promise<string> {
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', key);
  return bufToB64(pkcs8);
}

export async function importPrivateKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', b64ToBuf(b64), ALGO, true, ['deriveKey', 'deriveBits']);
}

export async function generateSigningKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(SIGN_ALGO, true, ['sign', 'verify']);
}

export async function exportSigningPublicKey(key: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey('spki', key);
  return bufToB64(spki);
}

export async function exportSigningPrivateKey(key: CryptoKey): Promise<string> {
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', key);
  return bufToB64(pkcs8);
}

export async function importSigningPrivateKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', b64ToBuf(b64), SIGN_ALGO, true, ['sign']);
}

export async function signNonce(privateKey: CryptoKey, nonceB64: string): Promise<string> {
  const nonce = b64ToBuf(nonceB64);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, nonce);
  return bufToB64(sig);
}

async function deriveAesKey(privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    AES,
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptForUser(
  plaintext: string,
  myPrivateKey: CryptoKey,
  theirPublicKey: CryptoKey
): Promise<{ ciphertext: string; iv: string }> {
  const aesKey = await deriveAesKey(myPrivateKey, theirPublicKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, encoded);
  return { ciphertext: bufToB64(cipher), iv: bytesToB64(iv) };
}

export async function decryptFromUser(
  ciphertext: string,
  iv: string,
  myPrivateKey: CryptoKey,
  theirPublicKey: CryptoKey
): Promise<string> {
  const aesKey = await deriveAesKey(myPrivateKey, theirPublicKey);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(b64ToBuf(iv)) },
    aesKey,
    b64ToBuf(ciphertext)
  );
  return new TextDecoder().decode(plain);
}

export interface DirectEnvelopeV2 {
  v: 2;
  epk: string;
  ct: string;
  iv: string;
}

export function isDirectEnvelopeV2(ciphertext: string): boolean {
  return ciphertext.startsWith('{') && ciphertext.includes('"v":2');
}

/** Per-message ephemeral ECDH — forward secrecy for new direct messages. */
export async function encryptDirectMessage(
  plaintext: string,
  theirPublicKey: CryptoKey
): Promise<{ ciphertext: string; iv: string }> {
  const ephem = await crypto.subtle.generateKey(ALGO, true, ['deriveKey']);
  const aesKey = await deriveAesKey(ephem.privateKey, theirPublicKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, encoded);
  const envelope: DirectEnvelopeV2 = {
    v: 2,
    epk: await exportPublicKey(ephem.publicKey),
    ct: bufToB64(cipher),
    iv: bytesToB64(iv),
  };
  return { ciphertext: JSON.stringify(envelope), iv: '' };
}

export async function decryptDirectMessage(
  ciphertext: string,
  iv: string,
  myPrivateKey: CryptoKey,
  theirPublicKey: CryptoKey
): Promise<string> {
  if (isDirectEnvelopeV2(ciphertext)) {
    const env = JSON.parse(ciphertext) as DirectEnvelopeV2;
    const ephemPub = await importPublicKey(env.epk);
    const aesKey = await deriveAesKey(myPrivateKey, ephemPub);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(b64ToBuf(env.iv)) },
      aesKey,
      b64ToBuf(env.ct)
    );
    return new TextDecoder().decode(plain);
  }
  const aesKey = await deriveAesKey(myPrivateKey, theirPublicKey);
  return decryptWithKey(ciphertext, iv, aesKey);
}

export async function encryptDirectBinary(
  data: ArrayBuffer,
  theirPublicKey: CryptoKey
): Promise<{ ciphertext: ArrayBuffer; iv: string; envelope: string }> {
  const ephem = await crypto.subtle.generateKey(ALGO, true, ['deriveKey']);
  const aesKey = await deriveAesKey(ephem.privateKey, theirPublicKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, data);
  const envelope: DirectEnvelopeV2 = {
    v: 2,
    epk: await exportPublicKey(ephem.publicKey),
    ct: bufToB64(cipher),
    iv: bytesToB64(iv),
  };
  return { ciphertext: cipher, iv: bytesToB64(iv), envelope: JSON.stringify(envelope) };
}

export async function decryptDirectBinary(
  envelopeOrCipher: string | ArrayBuffer,
  iv: string,
  myPrivateKey: CryptoKey,
  theirPublicKey: CryptoKey
): Promise<ArrayBuffer> {
  if (typeof envelopeOrCipher === 'string' && isDirectEnvelopeV2(envelopeOrCipher)) {
    const env = JSON.parse(envelopeOrCipher) as DirectEnvelopeV2;
    const ephemPub = await importPublicKey(env.epk);
    const aesKey = await deriveAesKey(myPrivateKey, ephemPub);
    return crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(b64ToBuf(env.iv)) },
      aesKey,
      b64ToBuf(env.ct)
    );
  }
  const cipherBuf = typeof envelopeOrCipher === 'string' ? b64ToBuf(envelopeOrCipher) : envelopeOrCipher;
  const aesKey = await deriveAesKey(myPrivateKey, theirPublicKey);
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(b64ToBuf(iv)) },
    aesKey,
    cipherBuf
  );
}

export async function generateGroupKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(AES, true, ['encrypt', 'decrypt']);
}

export async function exportGroupKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  return bufToB64(raw);
}

export async function importGroupKey(b64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', b64ToBuf(b64), AES, true, ['encrypt', 'decrypt']);
}

export async function encryptGroupKeyForMember(
  groupKeyRaw: string,
  myPrivateKey: CryptoKey,
  memberPublicKey: CryptoKey
): Promise<string> {
  const { ciphertext, iv } = await encryptForUser(groupKeyRaw, myPrivateKey, memberPublicKey);
  return JSON.stringify({ ciphertext, iv });
}

export async function wrapGroupKeyForMember(
  groupKeyRaw: string,
  myPrivateKey: CryptoKey,
  memberPublicKey: CryptoKey,
  encryptedByUserId: string
): Promise<string> {
  const { ciphertext, iv } = await encryptForUser(groupKeyRaw, myPrivateKey, memberPublicKey);
  return JSON.stringify({ ciphertext, iv, encryptedBy: encryptedByUserId });
}

export async function decryptGroupKey(
  encrypted: string,
  myPrivateKey: CryptoKey,
  senderPublicKey: CryptoKey
): Promise<CryptoKey> {
  const { ciphertext, iv } = JSON.parse(encrypted) as { ciphertext: string; iv: string };
  const raw = await decryptFromUser(ciphertext, iv, myPrivateKey, senderPublicKey);
  return importGroupKey(raw);
}

export async function encryptWithGroupKey(
  plaintext: string,
  groupKey: CryptoKey
): Promise<{ ciphertext: string; iv: string }> {
  return encryptWithKey(plaintext, groupKey);
}

export async function decryptWithGroupKey(
  ciphertext: string,
  iv: string,
  groupKey: CryptoKey
): Promise<string> {
  return decryptWithKey(ciphertext, iv, groupKey);
}

export async function encryptWithKey(
  plaintext: string,
  key: CryptoKey
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return { ciphertext: bufToB64(cipher), iv: bytesToB64(iv) };
}

export async function decryptWithKey(
  ciphertext: string,
  iv: string,
  key: CryptoKey
): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(b64ToBuf(iv)) },
    key,
    b64ToBuf(ciphertext)
  );
  return new TextDecoder().decode(plain);
}

export async function encryptBinary(
  data: ArrayBuffer,
  key: CryptoKey
): Promise<{ ciphertext: ArrayBuffer; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { ciphertext: cipher, iv: bytesToB64(iv) };
}

export async function decryptBinary(
  ciphertext: ArrayBuffer,
  iv: string,
  key: CryptoKey
): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(b64ToBuf(iv)) },
    key,
    ciphertext
  );
}

function bufToB64FromBuffer(buf: ArrayBuffer): string {
  return bufToB64(buf);
}

export { bufToB64FromBuffer as arrayBufferToBase64, b64ToBuf as base64ToArrayBuffer };
