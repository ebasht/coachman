/**
 * Background media hydration: text/stubs paint first; photo bytes (and video
 * stream URLs) fill in without blocking history/WS decrypt loops.
 */
import type { Chat } from './api';
import {
  decryptDirectBinary,
  decryptBinary,
  importPrivateKey,
  importPublicKey,
  importGroupKey,
  isDirectEnvelopeV2,
} from './crypto';
import { getChatEncryptionKey } from './messages-encrypt';
import { isPlainMediaIv, looksLikeMediaBytes } from './media-bytes';
import { getCachedImage, saveCachedImage, loadGroupKeyArchive, type StoredMessage } from './storage';
import { loadImageBytes } from './image-download';
import { resolveVideoPlaybackUrl, resolveVideoPosterUrl } from './video-preview';
import { clearTransferProgress, setTransferProgress } from './transfer-progress';

const CONCURRENCY = 4;

export type MediaHydrateContext = {
  chat: Chat;
  myUserId: string;
  myPrivateKeyB64: string;
};

type QueueItem = {
  msg: StoredMessage;
  ctx: MediaHydrateContext;
  resolve: (url: string | undefined) => void;
  reject: (err: unknown) => void;
};

const inFlight = new Map<string, Promise<string | undefined>>();
const queue: QueueItem[] = [];
let active = 0;

function progressKeyFor(msg: Pick<StoredMessage, 'id' | 'imageId'>): string {
  return msg.id || (msg.imageId ? `img:${msg.imageId}` : '');
}

function dedupeKey(msg: StoredMessage): string {
  if (msg.type === 'image' && msg.imageId) return `img:${msg.imageId}`;
  if (msg.type === 'video') return `vid:${msg.imageId || msg.id}`;
  return msg.id;
}

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

/** Download + cache photo bytes; returns a blob URL. */
export async function fetchAndCacheMessageImage(
  msg: Pick<StoredMessage, 'id' | 'imageId'>,
  ctx: MediaHydrateContext,
): Promise<string | undefined> {
  if (!msg.imageId) return undefined;

  const cached = await getCachedImage(msg.imageId);
  if (cached) {
    return URL.createObjectURL(new Blob([cached.data], { type: cached.mimeType }));
  }

  const progressKey = progressKeyFor(msg);
  try {
    const { bytes, mimeType, iv } = await loadImageBytes(msg.imageId, progressKey);
    // Photos are not encrypted. Only try a historical decrypt when the payload
    // is neither marked plain nor a recognizable image/video container.
    let plain = bytes;
    if (!isPlainMediaIv(iv) && !looksLikeMediaBytes(bytes)) {
      try {
        plain = await decryptLegacyImageBytes(
          bytes,
          iv,
          ctx.chat,
          ctx.myUserId,
          ctx.myPrivateKeyB64,
        );
      } catch {
        plain = bytes;
      }
    }
    await saveCachedImage(msg.imageId, plain, mimeType);
    return URL.createObjectURL(new Blob([plain], { type: mimeType }));
  } catch {
    clearTransferProgress(progressKey);
    return undefined;
  }
}

async function hydrateOne(
  msg: StoredMessage,
  ctx: MediaHydrateContext,
): Promise<string | undefined> {
  if (msg.type === 'video') {
    const url = await resolveVideoPlaybackUrl(msg);
    return url || undefined;
  }
  if (msg.type === 'image') {
    return fetchAndCacheMessageImage(msg, ctx);
  }
  return undefined;
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const item = queue.shift()!;
    active += 1;
    const key = progressKeyFor(item.msg);
    if (item.msg.type === 'image' && key) {
      // Promote queued → download once a worker picks it up (loadImageBytes also sets this).
      setTransferProgress(key, 0, 'download');
    }
    void hydrateOne(item.msg, item.ctx)
      .then(item.resolve, item.reject)
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

/**
 * Queue background hydration for one media message. Dedupes in-flight work by
 * imageId / video id. Marks transfer progress as queued until a worker starts.
 */
export function enqueueMediaHydrate(
  msg: StoredMessage,
  ctx: MediaHydrateContext,
): Promise<string | undefined> {
  if (msg.type !== 'image' && msg.type !== 'video') {
    return Promise.resolve(undefined);
  }
  if (msg.imageUrl) return Promise.resolve(msg.imageUrl);
  if (msg.type === 'image' && !msg.imageId) return Promise.resolve(undefined);

  const key = dedupeKey(msg);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const progressKey = progressKeyFor(msg);
  if (msg.type === 'image' && progressKey) {
    setTransferProgress(progressKey, 0, 'queued');
  }

  const promise = new Promise<string | undefined>((resolve, reject) => {
    queue.push({ msg, ctx, resolve, reject });
    pump();
  }).finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, promise);
  return promise;
}

export type HydratedMediaPatch = {
  id: string;
  chatId: string;
  imageUrl?: string;
  posterUrl?: string;
};

/**
 * Schedule hydration for every image/video row still missing a display URL.
 * Newest messages first so the visible tail of the feed fills sooner.
 * Invokes `onHydrated` as each item completes (may be called multiple times).
 */
export function scheduleMissingMediaHydration(
  messages: StoredMessage[],
  ctx: MediaHydrateContext,
  onHydrated: (patch: HydratedMediaPatch) => void,
): void {
  const missing = messages
    .filter(
      (m) =>
        (m.type === 'image' || m.type === 'video') &&
        !m.imageUrl &&
        (m.type === 'video' || !!m.imageId),
    )
    .sort((a, b) => b.createdAt - a.createdAt);

  for (const msg of missing) {
    void enqueueMediaHydrate(msg, ctx).then(async (imageUrl) => {
      if (!imageUrl) return;
      let posterUrl: string | undefined;
      if (msg.type === 'video') {
        try {
          posterUrl = await resolveVideoPosterUrl(msg);
        } catch {
          /* optional */
        }
      }
      onHydrated({
        id: msg.id,
        chatId: msg.chatId,
        imageUrl,
        posterUrl,
      });
    });
  }
}

/** True when a media bubble should show the empty placeholder shell. */
export function isMediaPlaceholder(msg: Pick<StoredMessage, 'type' | 'imageUrl' | 'failed'>): boolean {
  return (msg.type === 'image' || msg.type === 'video') && !msg.imageUrl && !msg.failed;
}
