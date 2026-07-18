import type { Chat, RawMessage } from './api';
import { fetchArrayBufferWithProgress } from './api';
import {
  decryptDirectBinary,
  decryptBinary,
  importPrivateKey,
  importPublicKey,
  importGroupKey,
  isDirectEnvelopeV2,
  base64ToArrayBuffer,
} from './crypto';
import {
  getChatEncryptionKey,
  isPlainIv,
  decryptLegacyChatMessage,
} from './messages-encrypt';
import {
  getCachedImage,
  saveCachedImage,
  loadGroupKeyArchive,
  getMessages,
} from './storage';
import { messageImageUrl } from './image-preview';
import { clearTransferProgress, setTransferProgress } from './transfer-progress';

async function decryptLegacyImageBytes(
  cipherBuf: ArrayBuffer,
  iv: string,
  chat: Chat,
  myUserId: string,
  myPrivateKeyB64: string,
): Promise<ArrayBuffer> {
  const privateKey = await importPrivateKey(myPrivateKeyB64);
  const other = chat.members.find((m) => m.id !== myUserId);
  const theirPub = other ? await importPublicKey(other.publicKey) : null;

  if (chat.type === 'group') {
    const tryDecrypt = async (key: Awaited<ReturnType<typeof importGroupKey>>) =>
      decryptBinary(cipherBuf, iv, key);

    try {
      return await tryDecrypt(await getChatEncryptionKey(chat, myUserId, myPrivateKeyB64));
    } catch {
      /* continue */
    }
    try {
      return await tryDecrypt(
        await getChatEncryptionKey(chat, myUserId, myPrivateKeyB64, { forceRefresh: true }),
      );
    } catch {
      /* continue */
    }
    const archive = await loadGroupKeyArchive(myUserId, chat.id);
    for (const keyB64 of Object.values(archive)) {
      try {
        return await tryDecrypt(await importGroupKey(keyB64));
      } catch {
        /* next */
      }
    }
    throw new Error('cannot decrypt image');
  }

  if (theirPub && isDirectEnvelopeV2(iv)) {
    return decryptDirectBinary(iv, '', privateKey, theirPub);
  }
  if (theirPub) {
    return decryptDirectBinary(cipherBuf, iv, privateKey, theirPub);
  }
  throw new Error('no peer key');
}

async function sleep(ms: number) {
  await new Promise((r) => window.setTimeout(r, ms));
}

/** Fetch image bytes with short retries (CDN object may lag right after upload). */
async function loadImageBytes(
  imageId: string,
  progressKey?: string,
): Promise<{ bytes: ArrayBuffer; mimeType: string; iv: string }> {
  const { api } = await import('./api');
  let lastErr: unknown;
  const key = progressKey || `img:${imageId}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (attempt === 0) setTransferProgress(key, 0, 'download');
      const img = await api.getImage(imageId);
      let bytes: ArrayBuffer;
      if (img.url) {
        bytes = await fetchArrayBufferWithProgress(img.url, (percent) =>
          setTransferProgress(key, percent, 'download'),
        );
      } else if (img.ciphertext) {
        setTransferProgress(key, 50, 'download');
        bytes = base64ToArrayBuffer(img.ciphertext);
        setTransferProgress(key, 100, 'download');
      } else {
        throw new Error('empty image payload');
      }
      if (!bytes.byteLength) throw new Error('empty image bytes');
      clearTransferProgress(key);
      return { bytes, mimeType: img.mimeType, iv: img.iv };
    } catch (err) {
      lastErr = err;
      await sleep(200 * (attempt + 1));
    }
  }
  clearTransferProgress(key);
  throw lastErr instanceof Error ? lastErr : new Error('image load failed');
}

export async function decryptMessage(
  msg: RawMessage,
  chat: Chat,
  myUserId: string,
  myPrivateKeyB64: string,
  _usernames: Map<string, string>,
): Promise<{ text: string; imageUrl?: string }> {
  if (msg.type === 'image' && msg.imageId) {
    const cached = await getCachedImage(msg.imageId);
    if (cached) {
      return {
        text: '📷 Изображение',
        imageUrl: URL.createObjectURL(new Blob([cached.data], { type: cached.mimeType })),
      };
    }
    const progressKey = msg.id || `img:${msg.imageId}`;
    try {
      const { bytes, mimeType, iv } = await loadImageBytes(msg.imageId, progressKey);
      const plain = isPlainIv(iv)
        ? bytes
        : await decryptLegacyImageBytes(bytes, iv, chat, myUserId, myPrivateKeyB64);

      await saveCachedImage(msg.imageId, plain, mimeType);
      const blob = new Blob([plain], { type: mimeType });
      return { text: '📷 Изображение', imageUrl: URL.createObjectURL(blob) };
    } catch {
      clearTransferProgress(progressKey);
      // Keep a recoverable stub — caller must still persist the message row.
      return { text: '📷 Изображение' };
    }
  }

  // Brief plaintext experiment (iv=plain) — still readable if any such rows exist.
  if (isPlainIv(msg.iv)) {
    return { text: msg.ciphertext };
  }

  // Own direct v2 envelopes were never readable from ciphertext alone.
  if (msg.senderId === myUserId && isDirectEnvelopeV2(msg.ciphertext)) {
    const local = await getMessages(msg.chatId);
    const hit = local.find((m) => m.id === msg.id);
    if (hit?.text && !hit.text.startsWith('[')) {
      const imageUrl = hit.type === 'image' ? await messageImageUrl(hit) : undefined;
      return { text: hit.text, imageUrl };
    }
    return { text: '[ваше сообщение]' };
  }

  try {
    const text = await decryptLegacyChatMessage(
      msg.ciphertext,
      msg.iv,
      chat,
      myUserId,
      myPrivateKeyB64,
    );
    return { text };
  } catch {
    // One force-refresh retry for group key races around WS delivery.
    if (chat.type === 'group') {
      try {
        await getChatEncryptionKey(chat, myUserId, myPrivateKeyB64, { forceRefresh: true });
        const text = await decryptLegacyChatMessage(
          msg.ciphertext,
          msg.iv,
          chat,
          myUserId,
          myPrivateKeyB64,
        );
        return { text };
      } catch {
        /* fall through */
      }
    }
    // Prefer already-decrypted local copy over a failure placeholder.
    const local = await getMessages(msg.chatId);
    const hit = local.find((m) => m.id === msg.id);
    if (hit?.text && !hit.text.startsWith('[')) {
      const imageUrl = hit.type === 'image' ? await messageImageUrl(hit) : undefined;
      return { text: hit.text, imageUrl };
    }
    // Migration edge: payload already stored as readable text without plain iv.
    if (msg.ciphertext && !/^[A-Za-z0-9+/=]{40,}$/.test(msg.ciphertext.trim())) {
      return { text: msg.ciphertext };
    }
    return { text: '[не удалось расшифровать]' };
  }
}
