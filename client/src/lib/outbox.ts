import { api, type RawMessage } from './api';
import { migrateLocalPreview } from './image-preview';
import { truncatePushBody } from './push-preview';
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
    imageCiphertext,
    imageIv,
    imageMimeType,
    msgCiphertext,
    msgIv,
    previewData,
    previewMimeType,
    createdAt: Date.now(),
  });
}

/** Network (and upload) only — local IndexedDB updates happen separately. */
async function deliverOutboxItem(item: OutboxItem): Promise<RawMessage> {
  // tempMessageId is the stable idempotency key across offline retries.
  const clientId = item.tempMessageId;

  if (item.kind === 'image') {
    const blob = new Blob([item.imageCiphertext]);
    const { id: imageId } = await api.uploadImage(item.chatId, blob, item.imageIv, item.imageMimeType);
    return api.sendMessage(item.chatId, {
      ciphertext: item.msgCiphertext,
      iv: item.msgIv,
      type: 'image',
      imageId,
      clientId,
      pushBody: 'Фото',
    });
  }

  const msgType = item.kind === 'text' ? 'text' : item.kind;
  return api.sendMessage(item.chatId, {
    ciphertext: item.ciphertext,
    iv: item.iv,
    type: msgType,
    clientId,
    pushBody: truncatePushBody(
      item.kind === 'text' ? item.plainText : (item.pushBody ?? item.plainText),
    ),
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

async function requeueOutboxItem(item: OutboxItem): Promise<void> {
  try {
    await addOutboxItem(item);
  } catch (err) {
    console.warn('outbox requeue failed', item.id, err);
  }
}

async function trySendItem(
  item: OutboxItem,
  onSent?: (msg: RawMessage) => void,
  onAuthRetry?: () => Promise<boolean>,
): Promise<SendAttempt> {
  // Claim before network I/O so a concurrent flush cannot send the same item twice.
  await removeOutboxItem(item.id);

  const fail = async (err: unknown): Promise<SendAttempt> => {
    // Never permanently drop user text/images — ambiguous iOS TypeErrors were wiping them.
    if (isUserContent(item) || isRetryableError(err)) {
      await requeueOutboxItem(item);
      return 'retryable';
    }
    await dropPoisonItem(item, err);
    return 'dropped';
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

    try {
      await finalizeLocalDelivery(item, msg);
    } catch (localErr) {
      // Server already accepted the message — do not requeue (would duplicate).
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
      continue;
    }
    // dropped or retryable: keep going — never head-of-line-block later messages.
    // A flaky timeout on #1 used to `break` and leave #2 unsent until a later trigger.
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
        // Full pass with zero sends — brief pause then one more attempt, then back off.
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
