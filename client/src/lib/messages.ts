import type { Chat, RawMessage } from './api';
import {
  decryptWithGroupKey,
  decryptDirectMessage,
  decryptDirectBinary,
  decryptBinary,
  importPrivateKey,
  importPublicKey,
  importGroupKey,
  isDirectEnvelopeV2,
  base64ToArrayBuffer,
} from './crypto';
import { getChatEncryptionKey } from './messages-encrypt';
import {
  getCachedImage,
  saveCachedImage,
  loadGroupKeyArchive,
  getMessages,
} from './storage';
import { messageImageUrl } from './image-preview';

async function decryptGroupMessage(
  msg: RawMessage,
  chat: Chat,
  myUserId: string,
  myPrivateKeyB64: string
): Promise<string> {
  const encKey = await getChatEncryptionKey(chat, myUserId, myPrivateKeyB64);
  try {
    return await decryptWithGroupKey(msg.ciphertext, msg.iv, encKey);
  } catch {
    const archive = await loadGroupKeyArchive(chat.id);
    const epochs = Object.keys(archive)
      .map(Number)
      .sort((a, b) => b - a);
    for (const epoch of epochs) {
      try {
        const key = await importGroupKey(archive[epoch]);
        return await decryptWithGroupKey(msg.ciphertext, msg.iv, key);
      } catch {
        // try older epoch
      }
    }
    throw new Error('cannot decrypt group message');
  }
}

export async function decryptMessage(
  msg: RawMessage,
  chat: Chat,
  myUserId: string,
  myPrivateKeyB64: string,
  _usernames: Map<string, string>
): Promise<{ text: string; imageUrl?: string }> {
  const privateKey = await importPrivateKey(myPrivateKeyB64);
  const other = chat.members.find((m) => m.id !== myUserId);
  const theirPub = other ? await importPublicKey(other.publicKey) : null;

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
      const cipherBuf = base64ToArrayBuffer(img.ciphertext);
      let plain: ArrayBuffer;

      if (chat.type === 'group') {
        const encKey = await getChatEncryptionKey(chat, myUserId, myPrivateKeyB64);
        try {
          plain = await decryptBinary(cipherBuf, img.iv, encKey);
        } catch {
          const archive = await loadGroupKeyArchive(chat.id);
          let decrypted = false;
          for (const keyB64 of Object.values(archive)) {
            try {
              plain = await decryptBinary(cipherBuf, img.iv, await importGroupKey(keyB64));
              decrypted = true;
              break;
            } catch {
              // try next
            }
          }
          if (!decrypted) throw new Error('cannot decrypt image');
        }
      } else if (theirPub && isDirectEnvelopeV2(img.iv)) {
        plain = await decryptDirectBinary(img.iv, '', privateKey, theirPub);
      } else if (theirPub) {
        plain = await decryptDirectBinary(cipherBuf, img.iv, privateKey, theirPub);
      } else {
        throw new Error('no peer key');
      }

      await saveCachedImage(msg.imageId, plain!, img.mimeType);
      const blob = new Blob([plain!], { type: img.mimeType });
      return { text: '📷 Изображение', imageUrl: URL.createObjectURL(blob) };
    } catch {
      return { text: '📷 [не удалось загрузить изображение]' };
    }
  }

  if (chat.type === 'group') {
    const text = await decryptGroupMessage(msg, chat, myUserId, myPrivateKeyB64);
    return { text };
  }

  if (!theirPub) {
    return { text: '[не удалось расшифровать]' };
  }

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
    const text = await decryptDirectMessage(msg.ciphertext, msg.iv, privateKey, theirPub);
    return { text };
  } catch {
    return { text: '[не удалось расшифровать]' };
  }
}
