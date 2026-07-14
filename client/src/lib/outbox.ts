import { api, type RawMessage } from './api';
import { migrateLocalPreview } from './image-preview';
import {
  addOutboxItem,
  deleteMessageLocal,
  getOutboxItems,
  removeOutboxItem,
  replacePendingMessage,
  saveCachedImage,
  type OutboxItem,
} from './storage';

export const OUTBOX_FLUSHED_EVENT = 'outbox-flushed';

export type OutboxFlushOptions = {
  onSent?: (msg: RawMessage) => void;
  onAuthRetry?: () => Promise<boolean>;
};

let defaultAuthRetry: (() => Promise<boolean>) | undefined;

export function setOutboxAuthRetry(fn: (() => Promise<boolean>) | undefined) {
  defaultAuthRetry = fn;
}

export function isOfflineError(err: unknown): boolean {
  if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return true;
  }
  if (!(err instanceof Error)) return false;
  const msg = err.message || '';

  // HTTP/API application errors — not "offline".
  if (
    /unauthorized|forbidden|internal error|bad request|ciphertext required|request failed/i.test(msg)
  ) {
    return false;
  }

  // iOS Safari/WebKit uses many TypeError strings for real network loss.
  if (err.name === 'TypeError' || err instanceof TypeError) {
    if (!msg.trim()) return true;
    return /fetch|network|offline|load failed|connection|internet|aborted|cancelled|canceled|timed out|timeout|lost|hostname|unreachable|SSL|TLS|kCF/i.test(
      msg,
    );
  }

  return /failed to fetch|networkerror|network request failed|timeout|превышено время|ожидания ответа|offline|err_network|connection was lost|internet connection/i.test(
    msg,
  );
}

export function isAuthError(err: unknown): boolean {
  return err instanceof Error && /unauthorized|401|forbidden|403/i.test(err.message);
}

function isRetryableError(err: unknown): boolean {
  return isOfflineError(err) || isAuthError(err);
}

function isUserContent(item: OutboxItem): boolean {
  return item.kind === 'text' || item.kind === 'image';
}

/** Only system items may be discarded. User text/images are never dropped. */
function isDisposableSystemError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message || '';
  return /ciphertext required|bad request|forbidden|not found|unsupported/i.test(msg);
}

export async function hasOutboxItems(): Promise<boolean> {
  const items = await getOutboxItems();
  return items.length > 0;
}

export async function enqueueTextOutbox(
  chatId: string,
  tempMessageId: string,
  ciphertext: string,
  iv: string,
  plainText: string,
) {
  const existing = await getOutboxItems();
  if (existing.some((item) => item.tempMessageId === tempMessageId)) return;
  await addOutboxItem({
    id: crypto.randomUUID(),
    chatId,
    tempMessageId,
    kind: 'text',
    ciphertext,
    iv,
    plainText,
    createdAt: Date.now(),
  });
}

export async function enqueueCallOutbox(
  chatId: string,
  tempMessageId: string,
  ciphertext: string,
  iv: string,
  plainText: string,
  pushBody: string,
) {
  const existing = await getOutboxItems();
  if (existing.some((item) => item.tempMessageId === tempMessageId)) return;
  await addOutboxItem({
    id: crypto.randomUUID(),
    chatId,
    tempMessageId,
    kind: 'call',
    ciphertext,
    iv,
    plainText,
    pushBody,
    createdAt: Date.now(),
  });
}

export async function enqueueListEventOutbox(
  chatId: string,
  tempMessageId: string,
  ciphertext: string,
  iv: string,
  plainText: string,
  pushBody: string,
) {
  const existing = await getOutboxItems();
  if (existing.some((item) => item.tempMessageId === tempMessageId)) return;
  await addOutboxItem({
    id: crypto.randomUUID(),
    chatId,
    tempMessageId,
    kind: 'list',
    ciphertext,
    iv,
    plainText,
    pushBody,
    createdAt: Date.now(),
  });
}

export async function enqueueImageOutbox(
  chatId: string,
  tempMessageId: string,
  imageCiphertext: ArrayBuffer,
  imageIv: string,
  imageMimeType: string,
  msgCiphertext: string,
  msgIv: string,
  previewData: ArrayBuffer,
  previewMimeType: string,
) {
  const existing = await getOutboxItems();
  if (existing.some((item) => item.tempMessageId === tempMessageId)) return;
  await addOutboxItem({
    id: crypto.randomUUID(),
    chatId,
    tempMessageId,
    kind: 'image',
    // Own copies — Blob/IDB/WebCrypto must not share a buffer that can be detached.
    imageCiphertext: imageCiphertext.slice(0),
    imageIv,
    imageMimeType,
    msgCiphertext,
    msgIv,
    previewData: previewData.slice(0),
    previewMimeType,
    createdAt: Date.now(),
  });
}

function cloneOutboxItem(item: OutboxItem): OutboxItem {
  if (item.kind !== 'image') return { ...item };
  return {
    ...item,
    imageCiphertext: item.imageCiphertext.slice(0),
    previewData: item.previewData.slice(0),
  };
}

async function persistOutboxProgress(item: OutboxItem): Promise<void> {
  await addOutboxItem(cloneOutboxItem(item));
}

/** Network (and upload) only — local IndexedDB updates happen separately. */
async function deliverOutboxItem(item: OutboxItem): Promise<RawMessage> {
  // tempMessageId is the stable idempotency key across offline retries.
  const clientId = item.tempMessageId;

  if (item.kind === 'image') {
    let imageId = item.uploadedImageId;
    if (!imageId) {
      if (!item.imageCiphertext || item.imageCiphertext.byteLength === 0) {
        throw new Error('empty image ciphertext in outbox');
      }
      const blob = new Blob([item.imageCiphertext.slice(0)]);
      const uploaded = await api.uploadImage(item.chatId, blob, item.imageIv, item.imageMimeType);
      imageId = uploaded.id;
      item.uploadedImageId = imageId;
      // Durable before sendMessage — crash between upload and send must not lose imageId.
      await persistOutboxProgress(item);
    }
    return api.sendMessage(item.chatId, {
      ciphertext: item.msgCiphertext,
      iv: item.msgIv,
      type: 'image',
      imageId,
      clientId,
    });
  }

  const msgType = item.kind === 'text' ? 'text' : item.kind;
  return api.sendMessage(item.chatId, {
    ciphertext: item.ciphertext,
    iv: item.iv,
    type: msgType,
    clientId,
  });
}

async function finalizeLocalDelivery(item: OutboxItem, msg: RawMessage): Promise<void> {
  const clientId = msg.clientId || item.tempMessageId;
  if (item.kind === 'image') {
    const imageId = msg.imageId;
    if (!imageId) throw new Error('missing imageId after upload');
    await saveCachedImage(imageId, item.previewData, item.previewMimeType);
    await migrateLocalPreview(item.tempMessageId, msg.id, imageId);
    await replacePendingMessage(item.tempMessageId, {
      id: msg.id,
      chatId: msg.chatId,
      senderId: msg.senderId,
      senderName: 'Я',
      text: '📷 Изображение',
      type: 'image',
      imageId,
      clientId,
      createdAt: msg.createdAt,
      pending: false,
    });
    return;
  }

  const msgType = item.kind === 'text' ? 'text' : item.kind;
  await replacePendingMessage(item.tempMessageId, {
    id: msg.id,
    chatId: msg.chatId,
    senderId: msg.senderId,
    senderName: 'Я',
    text: item.plainText,
    type: msgType,
    clientId,
    createdAt: msg.createdAt,
    pending: false,
  });
}

type SendAttempt = 'sent' | 'retryable' | 'dropped';

async function dropPoisonItem(item: OutboxItem, err: unknown): Promise<void> {
  console.warn('outbox item dropped', item.id, item.kind, err);
  try {
    await removeOutboxItem(item.id);
  } catch {
    // ignore
  }
  if (item.kind === 'call' || item.kind === 'list') {
    try {
      await deleteMessageLocal(item.tempMessageId, item.chatId);
    } catch {
      // ignore
    }
  }
}

/**
 * Deliver one outbox item.
 * Payload stays in IndexedDB until the server ACK (clientId-idempotent).
 * Never delete-before-send — that was the main message-loss path.
 */
async function trySendItem(
  item: OutboxItem,
  onSent?: (msg: RawMessage) => void,
  onAuthRetry?: () => Promise<boolean>,
): Promise<SendAttempt> {
  const fail = async (err: unknown): Promise<SendAttempt> => {
    // User content is never discarded — only system call/list poison pills.
    if (!isUserContent(item) && isDisposableSystemError(err)) {
      await dropPoisonItem(item, err);
      return 'dropped';
    }
    if (!isUserContent(item) && !isRetryableError(err)) {
      await dropPoisonItem(item, err);
      return 'dropped';
    }
    return 'retryable';
  };

  try {
    let msg: RawMessage;
    try {
      msg = await deliverOutboxItem(item);
    } catch (err) {
      if (isAuthError(err) && onAuthRetry) {
        const refreshed = await onAuthRetry();
        if (!refreshed) return fail(err);
        msg = await deliverOutboxItem(item);
      } else {
        return fail(err);
      }
    }

    // Server accepted (or returned idempotent existing). Only now drop durable payload.
    try {
      await removeOutboxItem(item.id);
    } catch (removeErr) {
      console.warn('outbox remove after ACK failed', item.id, removeErr);
      // Still finalize — retry of same clientId is safe.
    }

    try {
      await finalizeLocalDelivery(item, msg);
    } catch (localErr) {
      // Server already accepted the message — do not requeue (would only waste traffic).
      console.warn('outbox local finalize failed', item.id, localErr);
    }
    onSent?.(msg);
    return 'sent';
  } catch (err) {
    return fail(err);
  }
}

async function flushOutboxOnce(options?: OutboxFlushOptions): Promise<number> {
  const onSent = options?.onSent;
  const onAuthRetry = options?.onAuthRetry ?? defaultAuthRetry;

  const items = await getOutboxItems();
  if (items.length === 0) return 0;

  const sorted = [...items].sort((a, b) => a.createdAt - b.createdAt);
  let sent = 0;
  for (const item of sorted) {
    const result = await trySendItem(item, onSent, onAuthRetry);
    if (result === 'sent') {
      sent++;
    }
  }

  if (sent > 0) {
    window.dispatchEvent(new CustomEvent(OUTBOX_FLUSHED_EVENT, { detail: { sent } }));
  }
  return sent;
}

let flushChain: Promise<unknown> = Promise.resolve();
let scheduledRetry: number | null = null;

function scheduleOutboxRetry(delayMs: number) {
  if (scheduledRetry != null) return;
  scheduledRetry = window.setTimeout(() => {
    scheduledRetry = null;
    void flushOutbox();
  }, delayMs);
}

export async function flushOutbox(options?: OutboxFlushOptions): Promise<number> {
  // Always try: Safari/iOS can report navigator.onLine=false while fetch still works.
  // Mutex: serialize flushes so two concurrent callers cannot double-send the same item
  // while it still sits in IDB awaiting ACK.
  const run = async () => {
    let total = 0;
    let guard = 0;
    let stagnant = 0;

    while (guard < 40) {
      guard += 1;
      const before = await getOutboxItems();
      if (before.length === 0) break;

      const round = await flushOutboxOnce(options);
      total += round;

      const after = await getOutboxItems();
      if (after.length === 0) break;

      if (round === 0) {
        stagnant += 1;
        if (stagnant >= 2) {
          scheduleOutboxRetry(2500);
          break;
        }
        await new Promise((r) => window.setTimeout(r, 400));
        continue;
      }
      stagnant = 0;
    }
    return total;
  };

  const next = flushChain.then(run, run);
  flushChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
