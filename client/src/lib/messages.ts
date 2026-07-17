import type { Chat, RawMessage } from './api';
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
    const { api } = await import('./api');
    try {
      const img = await api.getImage(msg.imageId);
      let plain: ArrayBuffer;

      if (isPlainIv(img.iv)) {
        plain = base64ToArrayBuffer(img.ciphertext);
      } else {
        plain = await decryptLegacyImageBytes(
          base64ToArrayBuffer(img.ciphertext),
          img.iv,
          chat,
          myUserId,
          myPrivateKeyB64,
        );
      }

      await saveCachedImage(msg.imageId, plain, img.mimeType);
      const blob = new Blob([plain], { type: img.mimeType });
      return { text: '📷 Изображение', imageUrl: URL.createObjectURL(blob) };
    } catch {
      return { text: '📷 [не удалось загрузить изображение]' };
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
