import { api, type RawMessage } from './api';
import { uploadPhoto } from './photo-upload';
import { migrateLocalPreview } from './image-preview';
import {
  addOutboxItem,
  deleteMessageLocal,
  getMessages,
  getOutboxItems,
  removeOutboxItem,
  replacePendingMessage,
  saveMessage,
  saveCachedImage,
  type OutboxItem,
} from './storage';
import { clearTransferProgress, setTransferProgress } from './transfer-progress';

export const OUTBOX_FLUSHED_EVENT = 'outbox-flushed';
/** Fired when a message is marked failed (or a failure is cleared) so views refresh. */
export const OUTBOX_FAILED_EVENT = 'outbox-failed';

/** Image items with failedAt are parked: they never block the FIFO queue. */
function isActive(item: OutboxItem): boolean {
  return !(item.kind === 'image' && item.failedAt);
}

export type OutboxFlushOptions = {
  onSent?: (msg: RawMessage) => void;
  onAuthRetry?: () => Promise<boolean>;
  /** Ignore retry backoff — use for explicit signals (network back, focus, resume). */
  force?: boolean;
};

export type OutboxErrorInfo = {
  tempMessageId: string;
  chatId: string;
  kind: OutboxItem['kind'];
  message: string;
  /** false when the item was given up on (dropped from the queue). */
  willRetry: boolean;
};

let defaultAuthRetry: (() => Promise<boolean>) | undefined;
let errorReporter: ((info: OutboxErrorInfo) => void) | undefined;

export function setOutboxAuthRetry(fn: (() => Promise<boolean>) | undefined) {
  defaultAuthRetry = fn;
}

/** Surface real send failures to the UI instead of an endless silent spinner. */
export function setOutboxErrorReporter(fn: ((info: OutboxErrorInfo) => void) | undefined) {
  errorReporter = fn;
}

// How many non-offline failures before we give up on a user item and unblock the queue.
const MAX_SEND_ATTEMPTS = 4;
// In-memory attempt counters (reset on reload — offline waits don't count).
const attemptCounts = new Map<string, number>();
// Throttle duplicate error toasts per item.
const reportedErrors = new Set<string>();

function reportOutboxError(item: OutboxItem, message: string, willRetry: boolean) {
  const dedupeKey = `${item.tempMessageId}:${willRetry}:${message}`;
  if (reportedErrors.has(dedupeKey)) return;
  reportedErrors.add(dedupeKey);
  try {
    errorReporter?.({
      tempMessageId: item.tempMessageId,
      chatId: item.chatId,
      kind: item.kind,
      message,
      willRetry,
    });
  } catch {
    // ignore reporter faults
  }
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

/** Corrupt / unreadable image payloads will never succeed — drop instead of infinite retry. */
function isPoisonImageError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message || '';
  return /empty image|file, iv, mimeType required|invalid multipart|detached arraybuffer|слишком бол|too large|entity too large|413/i.test(
    msg,
  );
}

export async function hasOutboxItems(): Promise<boolean> {
  const items = await getOutboxItems();
  return items.length > 0;
}

/** True while a previous flush hit a retryable wall and is waiting to try again. */
export function isOutboxCoolingDown(): boolean {
  return Date.now() < cooldownUntil;
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
  wakeOutbox();
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
    notify: 'badge',
    createdAt: Date.now(),
  });
  wakeOutbox();
}

export async function enqueueListEventOutbox(
  chatId: string,
  tempMessageId: string,
  ciphertext: string,
  iv: string,
  plainText: string,
  pushBody: string,
  notify: 'alert' | 'badge' = 'badge',
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
    notify,
    createdAt: Date.now(),
  });
  wakeOutbox();
}

/** Photo bytes from an outbox row (supports legacy `imageCiphertext` field name in IDB). */
function outboxImageBytes(item: Extract<OutboxItem, { kind: 'image' }>): ArrayBuffer | undefined {
  const legacy = item as OutboxItem & { imageCiphertext?: ArrayBuffer };
  const bytes = item.imageBytes ?? legacy.imageCiphertext;
  return bytes?.byteLength ? bytes : undefined;
}

export async function enqueueImageOutbox(
  chatId: string,
  tempMessageId: string,
  imageBytes: ArrayBuffer,
  imageMimeType: string,
  msgCiphertext: string,
  msgIv: string,
  previewData: ArrayBuffer,
  previewMimeType: string,
  albumId?: string,
) {
  const existing = await getOutboxItems();
  if (existing.some((item) => item.tempMessageId === tempMessageId)) return;
  await addOutboxItem({
    id: crypto.randomUUID(),
    chatId,
    tempMessageId,
    kind: 'image',
    // Own copies — Blob/IDB must not share a buffer that can be detached.
    // Photo bytes are plaintext (not E2E-encrypted).
    imageBytes: imageBytes.slice(0),
    imageMimeType,
    msgCiphertext,
    msgIv,
    previewData: previewData.slice(0),
    previewMimeType,
    albumId,
    createdAt: Date.now(),
  });
  // Wait in send queue until flush reaches this item (one upload at a time).
  setTransferProgress(tempMessageId, 0, 'queued');
  wakeOutbox();
}

/** New work cancels backoff so the queue can run immediately. */
function wakeOutbox() {
  retryAttempt = 0;
  cooldownUntil = 0;
  // Allow fresh error reporting after an explicit new action.
  reportedErrors.clear();
  if (scheduledRetry != null) {
    window.clearTimeout(scheduledRetry);
    scheduledRetry = null;
  }
}

/** Mark pending image uploads (except the active one) as waiting in queue. */
function markImageQueue(items: OutboxItem[], activeTempId?: string) {
  for (const item of items) {
    if (item.kind !== 'image') continue;
    if (item.uploadedImageId) continue;
    if (activeTempId && item.tempMessageId === activeTempId) continue;
    const cur = item.tempMessageId;
    // Don't stomp an in-flight upload percent.
    setTransferProgress(cur, 0, 'queued');
  }
}

function cloneOutboxItem(item: OutboxItem): OutboxItem {
  if (item.kind !== 'image') return { ...item };
  const bytes = outboxImageBytes(item);
  return {
    ...item,
    imageBytes: bytes ? bytes.slice(0) : new ArrayBuffer(0),
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
      const src = outboxImageBytes(item);
      if (!src) throw new Error('empty image in outbox');
      const bytes = src.slice(0);
      const blob = new Blob([bytes], {
        type: item.imageMimeType || 'application/octet-stream',
      });
      const progressKey = item.tempMessageId;
      setTransferProgress(progressKey, 0, 'upload');
      try {
        // Direct browser → Yandex Object Storage (presigned PUT). The photo bytes
        // never pass through nginx or the Go backend.
        const uploaded = await uploadPhoto({
          chatId: item.chatId,
          blob,
          onProgress: (percent) => setTransferProgress(progressKey, percent, 'upload'),
        });
        imageId = uploaded.attachmentId;
        item.uploadedImageId = imageId;
        // Durable before sendMessage — crash between upload and send must not lose imageId.
        await persistOutboxProgress(item);
      } catch (err) {
        setTransferProgress(progressKey, 0, 'queued');
        throw err;
      }
    } else {
      setTransferProgress(item.tempMessageId, 100, 'upload');
    }
    try {
      const sent = await api.sendMessage(item.chatId, {
        ciphertext: item.msgCiphertext,
        iv: item.msgIv,
        type: 'image',
        imageId,
        albumId: item.albumId,
        clientId,
      });
      clearTransferProgress(item.tempMessageId);
      return sent;
    } catch (err) {
      // Upload already done — keep a finished bar; message send will retry.
      setTransferProgress(item.tempMessageId, 100, 'upload');
      throw err;
    }
  }

  const msgType = item.kind === 'text' ? 'text' : item.kind;
  const notify =
    item.kind === 'call' || item.kind === 'list' ? (item.notify ?? 'badge') : undefined;
  return api.sendMessage(item.chatId, {
    ciphertext: item.ciphertext,
    iv: item.iv,
    type: msgType,
    clientId,
    ...(notify ? { notify } : {}),
  });
}

async function finalizeLocalDelivery(item: OutboxItem, msg: RawMessage): Promise<void> {
  const clientId = msg.clientId || item.tempMessageId;
  if (item.kind === 'image') {
    const imageId = msg.imageId || item.uploadedImageId;
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
      albumId: msg.albumId ?? item.albumId,
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
  clearTransferProgress(item.tempMessageId);
  try {
    await removeOutboxItem(item.id);
  } catch {
    // ignore
  }
  if (item.kind === 'call' || item.kind === 'list' || item.kind === 'image') {
    try {
      await deleteMessageLocal(item.tempMessageId, item.chatId);
    } catch {
      // ignore
    }
  }
}

/**
 * Park a failed photo: keep its bytes in the outbox (for retry) but flag it so
 * flush skips it — the FIFO queue moves on to the next photo instead of blocking.
 * The chat bubble shows an inline "upload failed" with the reason.
 */
async function markImageFailed(item: OutboxItem, message: string): Promise<void> {
  clearTransferProgress(item.tempMessageId);
  attemptCounts.delete(item.tempMessageId);
  if (item.kind === 'image') {
    try {
      await addOutboxItem(
        cloneOutboxItem({ ...item, failedAt: Date.now(), failReason: message }),
      );
    } catch {
      // ignore persistence faults
    }
  }
  try {
    const rows = await getMessages(item.chatId);
    const row = rows.find((m) => m.id === item.tempMessageId);
    if (row) {
      await saveMessage({ ...row, pending: false, failed: true, error: message });
    }
  } catch {
    // ignore
  }
  reportOutboxError(item, message, false);
  window.dispatchEvent(
    new CustomEvent(OUTBOX_FAILED_EVENT, { detail: { tempMessageId: item.tempMessageId, chatId: item.chatId } }),
  );
}

/** Retry a previously failed photo: unpark it, reset its state, and re-run the queue. */
export async function retryOutboxItem(tempMessageId: string): Promise<void> {
  const items = await getOutboxItems();
  const item = items.find((i) => i.tempMessageId === tempMessageId);
  if (!item || item.kind !== 'image') return;

  attemptCounts.delete(tempMessageId);
  const { failedAt, failReason, ...rest } = item;
  void failedAt;
  void failReason;
  await addOutboxItem(cloneOutboxItem(rest as OutboxItem));

  try {
    const rows = await getMessages(item.chatId);
    const row = rows.find((m) => m.id === tempMessageId);
    if (row) {
      await saveMessage({ ...row, failed: false, error: undefined, pending: true });
    }
  } catch {
    // ignore
  }
  setTransferProgress(tempMessageId, 0, 'queued');
  window.dispatchEvent(
    new CustomEvent(OUTBOX_FAILED_EVENT, { detail: { tempMessageId, chatId: item.chatId } }),
  );
  await flushOutbox({ force: true });
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
    const message = err instanceof Error ? err.message : String(err ?? 'Неизвестная ошибка');

    // System items (call/list) — drop on any non-retryable error.
    if (!isUserContent(item) && isDisposableSystemError(err)) {
      await dropPoisonItem(item, err);
      return 'dropped';
    }
    if (!isUserContent(item) && !isRetryableError(err)) {
      await dropPoisonItem(item, err);
      return 'dropped';
    }

    // Offline failures retry forever (they heal on their own) — keep the
    // item queued and stop this pass so ordering is preserved.
    if (isOfflineError(err)) {
      return 'retryable';
    }

    // Auth failures (401/403) heal after a token refresh — never a permanent
    // failure. This matters most for photos: a single transient 401 (token
    // expiry, or the refresh race while background polls run) must NOT park the
    // photo as failed. Keep it queued; the next flush runs after refreshSession.
    if (isAuthError(err)) {
      reportOutboxError(item, message, true);
      return 'retryable';
    }

    if (item.kind === 'image') {
      // Empty/corrupt payload with no bytes can never succeed — drop entirely.
      const noBytes = !item.uploadedImageId && !outboxImageBytes(item);
      if (isPoisonImageError(err) && noBytes) {
        reportOutboxError(item, message, false);
        await dropPoisonItem(item, err);
        return 'dropped';
      }
      // Real per-photo failure: mark this photo failed (inline error) and MOVE ON
      // to the next one. The queue is no longer blocked by a single bad photo.
      console.warn('outbox image send failed — parking as failed', item.tempMessageId, message);
      await markImageFailed(item, message);
      return 'dropped';
    }

    // Non-image user content (text): retry with a cap so it can't block forever.
    const attempts = (attemptCounts.get(item.tempMessageId) ?? 0) + 1;
    attemptCounts.set(item.tempMessageId, attempts);
    console.warn(
      `outbox ${item.kind} send failed (attempt ${attempts}/${MAX_SEND_ATTEMPTS})`,
      item.tempMessageId,
      message,
    );
    if (attempts >= MAX_SEND_ATTEMPTS) {
      reportOutboxError(item, message, false);
      attemptCounts.delete(item.tempMessageId);
      await dropPoisonItem(item, err);
      return 'dropped';
    }
    reportOutboxError(item, message, true);
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
    clearTransferProgress(item.tempMessageId);
    attemptCounts.delete(item.tempMessageId);
    onSent?.(msg);
    return 'sent';
  } catch (err) {
    return fail(err);
  }
}

type FlushRound = { sent: number; blocked: boolean };

async function flushOutboxOnce(options?: OutboxFlushOptions): Promise<FlushRound> {
  const onSent = options?.onSent;
  const onAuthRetry = options?.onAuthRetry ?? defaultAuthRetry;

  // Skip parked (failed) items — they must not block the queue.
  const items = (await getOutboxItems()).filter(isActive);
  if (items.length === 0) return { sent: 0, blocked: false };

  // Strict FIFO: one item at a time. On offline failure stop so later items
  // stay queued (no reordering). A per-photo error is parked and we move on.
  const sorted = [...items].sort((a, b) => a.createdAt - b.createdAt);
  markImageQueue(sorted);

  let sent = 0;
  for (const item of sorted) {
    if (item.kind === 'image') {
      markImageQueue(sorted, item.tempMessageId);
    }

    const result = await trySendItem(item, onSent, onAuthRetry);
    if (result === 'sent') {
      sent++;
      window.dispatchEvent(new CustomEvent(OUTBOX_FLUSHED_EVENT, { detail: { sent: 1 } }));
      continue;
    }
    if (result === 'retryable') {
      return { sent, blocked: true };
    }
    // dropped — continue with next
  }

  return { sent, blocked: false };
}

let flushChain: Promise<unknown> = Promise.resolve();
let scheduledRetry: number | null = null;
let retryAttempt = 0;
let cooldownUntil = 0;

function scheduleOutboxRetry() {
  const delay = Math.min(60_000, 3_000 * 2 ** Math.min(retryAttempt, 4));
  retryAttempt += 1;
  cooldownUntil = Date.now() + delay;
  if (scheduledRetry != null) return;
  scheduledRetry = window.setTimeout(() => {
    scheduledRetry = null;
    // Allow the scheduled run even if cooldown math is slightly off.
    cooldownUntil = 0;
    void flushOutbox();
  }, delay);
}

export async function flushOutbox(options?: OutboxFlushOptions): Promise<number> {
  // Always try: Safari/iOS can report navigator.onLine=false while fetch still works.
  // Mutex: serialize flushes so two concurrent callers cannot double-send the same item
  // while it still sits in IDB awaiting ACK.
  if (options?.force) wakeOutbox();

  const run = async () => {
    // Interval / overlapping callers must not hammer a failing head-of-queue.
    if (!options?.force && Date.now() < cooldownUntil) {
      return 0;
    }

    let total = 0;
    for (let guard = 0; guard < 40; guard++) {
      const before = (await getOutboxItems()).filter(isActive);
      if (before.length === 0) {
        retryAttempt = 0;
        cooldownUntil = 0;
        break;
      }

      const { sent, blocked } = await flushOutboxOnce(options);
      total += sent;

      if (blocked) {
        // Do NOT immediately re-enter — that was the infinite upload loop.
        scheduleOutboxRetry();
        break;
      }

      const after = (await getOutboxItems()).filter(isActive);
      if (after.length === 0) {
        retryAttempt = 0;
        cooldownUntil = 0;
        break;
      }

      // Only drops left or newly enqueued items — continue once; if nothing sends, back off.
      if (sent === 0) {
        scheduleOutboxRetry();
        break;
      }
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
