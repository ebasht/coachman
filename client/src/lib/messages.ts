import type { Chat, RawMessage } from './api';
import { isDirectEnvelopeV2 } from './crypto';
import {
  getChatEncryptionKey,
  isPlainIv,
  decryptLegacyChatMessage,
} from './messages-encrypt';
import { getCachedImage, getMessages } from './storage';
import { messageImageUrl } from './image-preview';
import { looksLikeLegacyPlaintext } from './ciphertext-display';
export { isMediaMessageType, prioritizeTextMessages } from './message-priority';

/**
 * Decrypt / materialize a message envelope for the feed.
 *
 * Photos and videos: stub only. Bytes / stream URLs load via
 * {@link enqueueMediaHydrate} so later text rows are never blocked.
 */
export async function decryptMessage(
  msg: RawMessage,
  chat: Chat,
  myUserId: string,
  myPrivateKeyB64: string,
  _usernames: Map<string, string>,
): Promise<{ text: string; imageUrl?: string }> {
  if (msg.type === 'video' && msg.imageId) {
    return { text: '🎬 Видео' };
  }

  if (msg.type === 'image' && msg.imageId) {
    const cached = await getCachedImage(msg.imageId);
    if (cached) {
      return {
        text: '📷 Изображение',
        imageUrl: URL.createObjectURL(new Blob([cached.data], { type: cached.mimeType })),
      };
    }
    // Stub only — keep the feed contiguous; bytes load in the background.
    return { text: '📷 Изображение' };
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
      const imageUrl =
        hit.type === 'image' || hit.type === 'video' ? await messageImageUrl(hit) : undefined;
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
      const imageUrl =
        hit.type === 'image' || hit.type === 'video' ? await messageImageUrl(hit) : undefined;
      return { text: hit.text, imageUrl };
    }
    // Migration edge: readable text stored without plain iv (not base64 ciphertext).
    if (msg.ciphertext && looksLikeLegacyPlaintext(msg.ciphertext)) {
      return { text: msg.ciphertext };
    }
    return { text: '[не удалось расшифровать]' };
  }
}
