// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboxItem, StoredMessage } from './storage';
import type { RawMessage } from './api';

const addOutboxItem = vi.fn();
const getOutboxItems = vi.fn();
const removeOutboxItem = vi.fn();
const getMessages = vi.fn();
const saveMessage = vi.fn();
const deleteMessageLocal = vi.fn();
const listOrphanPendingMessages = vi.fn();
const saveCachedImage = vi.fn();
const upsertStoredMessage = vi.fn();
const sendMessage = vi.fn();
const uploadImage = vi.fn();
const uploadPhoto = vi.fn();
const uploadVideo = vi.fn();
const migrateLocalPreview = vi.fn();
const migrateVideoPoster = vi.fn();
const setTransferProgress = vi.fn();
const clearTransferProgress = vi.fn();

vi.mock('./storage', () => ({
  addOutboxItem: (...args: unknown[]) => addOutboxItem(...args),
  getOutboxItems: (...args: unknown[]) => getOutboxItems(...args),
  removeOutboxItem: (...args: unknown[]) => removeOutboxItem(...args),
  getMessages: (...args: unknown[]) => getMessages(...args),
  saveMessage: (...args: unknown[]) => saveMessage(...args),
  deleteMessageLocal: (...args: unknown[]) => deleteMessageLocal(...args),
  listOrphanPendingMessages: (...args: unknown[]) => listOrphanPendingMessages(...args),
  saveCachedImage: (...args: unknown[]) => saveCachedImage(...args),
}));

vi.mock('./api', () => ({
  api: {
    sendMessage: (...args: unknown[]) => sendMessage(...args),
    uploadImage: (...args: unknown[]) => uploadImage(...args),
  },
}));

vi.mock('./photo-upload', () => ({
  uploadPhoto: (...args: unknown[]) => uploadPhoto(...args),
}));

vi.mock('./video-upload', () => ({
  uploadVideo: (...args: unknown[]) => uploadVideo(...args),
}));

vi.mock('./image-preview', () => ({
  migrateLocalPreview: (...args: unknown[]) => migrateLocalPreview(...args),
}));

vi.mock('./video-preview', () => ({
  migrateVideoPoster: (...args: unknown[]) => migrateVideoPoster(...args),
}));

vi.mock('./transfer-progress', () => ({
  setTransferProgress: (...args: unknown[]) => setTransferProgress(...args),
  clearTransferProgress: (...args: unknown[]) => clearTransferProgress(...args),
}));

vi.mock('./message-upsert', () => ({
  upsertStoredMessage: (...args: unknown[]) => upsertStoredMessage(...args),
}));

const {
  enqueueTextOutbox,
  enqueueImageOutbox,
  enqueueVideoOutbox,
  flushOutbox,
  sendTextMessage,
  retryOutboxItem,
  outboxClientId,
  outboxItemId,
} = await import('./outbox');

let outbox: OutboxItem[] = [];
let messages: StoredMessage[] = [];
let sendSeq = 0;

function sentClientIds(): string[] {
  return sendMessage.mock.calls.map((call) => {
    const body = call[1] as { clientId?: string };
    return body.clientId as string;
  });
}

function ackMessage(chatId: string, clientId: string, type: RawMessage['type'] = 'text'): RawMessage {
  sendSeq += 1;
  return {
    id: `srv-${sendSeq}`,
    chatId,
    senderId: 'me',
    ciphertext: 'c',
    iv: 'iv',
    type,
    clientId,
    sequence: sendSeq,
    createdAt: Date.now(),
    ...(type === 'image' || type === 'video' ? { imageId: `img-${sendSeq}` } : {}),
  };
}

beforeEach(() => {
  outbox = [];
  messages = [];
  sendSeq = 0;
  vi.clearAllMocks();
  vi.useRealTimers();

  addOutboxItem.mockImplementation(async (item: OutboxItem) => {
    const idx = outbox.findIndex((row) => row.id === item.id);
    if (idx >= 0) outbox[idx] = item;
    else outbox.push(item);
  });
  getOutboxItems.mockImplementation(async () => outbox.map((item) => ({ ...item })));
  removeOutboxItem.mockImplementation(async (id: string) => {
    outbox = outbox.filter((item) => item.id !== id);
  });
  getMessages.mockImplementation(async () => messages.map((m) => ({ ...m })));
  saveMessage.mockImplementation(async (m: StoredMessage) => {
    const idx = messages.findIndex((row) => row.id === m.id);
    if (idx >= 0) messages[idx] = m;
    else messages.push(m);
  });
  upsertStoredMessage.mockImplementation(async (m: StoredMessage) => m);
  listOrphanPendingMessages.mockResolvedValue([]);
  migrateLocalPreview.mockResolvedValue(undefined);
  migrateVideoPoster.mockResolvedValue(undefined);
  saveCachedImage.mockResolvedValue(undefined);
  uploadPhoto.mockResolvedValue({
    attachmentId: 'att-photo',
    width: 1,
    height: 1,
    size: 1,
    contentType: 'image/jpeg',
    url: 'https://example.test/p',
  });
  uploadVideo.mockResolvedValue({
    attachmentId: 'att-video',
    width: 1,
    height: 1,
    size: 1,
    contentType: 'video/mp4',
    url: 'https://example.test/v',
  });
});

describe('outboxClientId', () => {
  it('normalizes pending-* and bare ids to one stable identity', () => {
    expect(outboxClientId('abc')).toBe('abc');
    expect(outboxClientId('pending-abc')).toBe('abc');
  });

  it('uses a deterministic IndexedDB key instead of a duplicate-detection scan', () => {
    expect(outboxItemId('text', 'pending-abc')).toBe('text:abc');
    expect(outboxItemId('image', 'abc')).toBe('image:abc');
  });
});

describe('outbox clientId stability (text)', () => {
  const chatId = 'chat-1';
  const clientId = 'cid-text-1';

  async function enqueueText() {
    messages.push({
      id: `pending-${clientId}`,
      chatId,
      senderId: 'me',
      senderName: 'Я',
      text: 'hello',
      type: 'text',
      clientId,
      createdAt: 1,
      pending: true,
    });
    await enqueueTextOutbox(chatId, clientId, 'cipher', 'iv', 'hello');
  }

  it('starts the foreground POST without rereading the entire outbox', async () => {
    getOutboxItems.mockImplementation(async () => new Promise<OutboxItem[]>(() => {}));
    sendMessage.mockImplementation(async (cid: string, body: { clientId?: string }) =>
      ackMessage(cid, body.clientId || clientId),
    );

    const sent = await sendTextMessage(chatId, clientId, 'hello', 'plain', 'hello');

    expect(sent.clientId).toBe(clientId);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(getOutboxItems).not.toHaveBeenCalled();
  });

  it('failed → retry preserves clientId', async () => {
    await enqueueText();
    sendMessage.mockRejectedValueOnce(new Error('forbidden'));
    await flushOutbox({ force: true, lane: 'message' });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.tempMessageId).toBe(clientId);
    expect(('failedAt' in outbox[0]! && outbox[0]!.failedAt) || false).toBeTruthy();

    sendMessage.mockImplementation(async (cid: string, body: { clientId?: string }) =>
      ackMessage(cid, body.clientId || clientId),
    );
    await retryOutboxItem(clientId);

    expect(sentClientIds().length).toBeGreaterThanOrEqual(2);
    expect(new Set(sentClientIds())).toEqual(new Set([clientId]));
    expect(outbox).toHaveLength(0);
  });

  it('several retries preserve clientId', async () => {
    await enqueueText();
    sendMessage
      .mockRejectedValueOnce(new Error('forbidden'))
      .mockRejectedValueOnce(new Error('forbidden'))
      .mockRejectedValueOnce(new Error('forbidden'));

    await flushOutbox({ force: true, lane: 'message' });
    await retryOutboxItem(`pending-${clientId}`);
    await retryOutboxItem(clientId);

    sendMessage.mockImplementation(async (cid: string, body: { clientId?: string }) =>
      ackMessage(cid, body.clientId || clientId),
    );
    await retryOutboxItem(clientId);

    const ids = sentClientIds();
    expect(ids.length).toBe(4);
    expect(ids.every((id) => id === clientId)).toBe(true);
  });

  it('reconnect flush preserves clientId', async () => {
    await enqueueText();
    sendMessage
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockImplementation(async (cid: string, body: { clientId?: string }) =>
        ackMessage(cid, body.clientId || clientId),
      );

    await flushOutbox({ force: true, lane: 'message' });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.tempMessageId).toBe(clientId);

    await flushOutbox({ force: true, lane: 'message' });
    expect(outbox).toHaveLength(1);

    await flushOutbox({ force: true, lane: 'message' });
    expect(outbox).toHaveLength(0);

    const ids = sentClientIds();
    expect(ids.length).toBe(3);
    expect(ids.every((id) => id === clientId)).toBe(true);
  });

  it('sends truncated plaintext as pushBody', async () => {
    messages.push({
      id: `pending-${clientId}`,
      chatId,
      senderId: 'me',
      senderName: 'Я',
      text: 'hello',
      type: 'text',
      clientId,
      createdAt: 1,
      pending: true,
    });
    await enqueueTextOutbox(chatId, clientId, 'cipher', 'iv', '  Привет   мир  ');
    sendMessage.mockImplementation(async (cid: string, body: { clientId?: string; pushBody?: string }) => {
      expect(body.pushBody).toBe('Привет мир');
      return ackMessage(cid, body.clientId || clientId);
    });
    await flushOutbox({ force: true, lane: 'message' });
    expect(sendMessage).toHaveBeenCalled();
  });
});

describe('outbox clientId stability (image)', () => {
  const chatId = 'chat-img';
  const clientId = 'cid-image-1';

  async function enqueueImage() {
    messages.push({
      id: `pending-${clientId}`,
      chatId,
      senderId: 'me',
      senderName: 'Я',
      text: '📷 Изображение',
      type: 'image',
      clientId,
      createdAt: 1,
      pending: true,
    });
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
    await enqueueImageOutbox(chatId, clientId, bytes, 'image/jpeg', '{}', 'plain', bytes, 'image/jpeg');
  }

  it('failed → retry preserves clientId', async () => {
    await enqueueImage();
    sendMessage.mockRejectedValueOnce(new Error('forbidden'));
    await flushOutbox({ force: true, lane: 'image' });
    expect(outbox[0]!.tempMessageId).toBe(clientId);

    sendMessage.mockImplementation(async (cid: string, body: { clientId?: string }) =>
      ackMessage(cid, body.clientId || clientId, 'image'),
    );
    await retryOutboxItem(`pending-${clientId}`);

    expect(sentClientIds().every((id) => id === clientId)).toBe(true);
    expect(sentClientIds().length).toBeGreaterThanOrEqual(2);
  });

  it('several retries preserve clientId', async () => {
    await enqueueImage();
    sendMessage
      .mockRejectedValueOnce(new Error('forbidden'))
      .mockRejectedValueOnce(new Error('forbidden'))
      .mockImplementation(async (cid: string, body: { clientId?: string }) =>
        ackMessage(cid, body.clientId || clientId, 'image'),
      );

    await flushOutbox({ force: true, lane: 'image' });
    await retryOutboxItem(clientId);
    await retryOutboxItem(clientId);

    expect(sentClientIds().every((id) => id === clientId)).toBe(true);
    expect(sentClientIds().length).toBe(3);
  });

  it('reconnect flush preserves clientId', async () => {
    await enqueueImage();
    // Offline on message send after upload — item stays active for reconnect flush.
    sendMessage
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockImplementation(async (cid: string, body: { clientId?: string }) =>
        ackMessage(cid, body.clientId || clientId, 'image'),
      );

    await flushOutbox({ force: true, lane: 'image' });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.tempMessageId).toBe(clientId);

    await flushOutbox({ force: true, lane: 'image' });
    expect(outbox).toHaveLength(0);
    expect(sentClientIds().every((id) => id === clientId)).toBe(true);
  });
});

describe('outbox clientId stability (video)', () => {
  const chatId = 'chat-vid';
  const clientId = 'cid-video-1';

  async function enqueueVideo() {
    messages.push({
      id: `pending-${clientId}`,
      chatId,
      senderId: 'me',
      senderName: 'Я',
      text: '🎬 Видео',
      type: 'video',
      clientId,
      createdAt: 1,
      pending: true,
    });
    const bytes = new Uint8Array([9, 8, 7, 6]).buffer;
    await enqueueVideoOutbox(chatId, clientId, bytes, 'video/mp4', '{}', 'plain', bytes, 'image/jpeg');
  }

  it('failed → retry preserves clientId', async () => {
    await enqueueVideo();
    sendMessage.mockRejectedValueOnce(new Error('forbidden'));
    await flushOutbox({ force: true, lane: 'image' });
    expect(outbox[0]!.tempMessageId).toBe(clientId);

    sendMessage.mockImplementation(async (cid: string, body: { clientId?: string }) =>
      ackMessage(cid, body.clientId || clientId, 'video'),
    );
    await retryOutboxItem(clientId);

    expect(sentClientIds().every((id) => id === clientId)).toBe(true);
    expect(sentClientIds().length).toBeGreaterThanOrEqual(2);
  });

  it('reconnect flush preserves clientId', async () => {
    await enqueueVideo();
    sendMessage
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockImplementation(async (cid: string, body: { clientId?: string }) =>
        ackMessage(cid, body.clientId || clientId, 'video'),
      );

    await flushOutbox({ force: true, lane: 'image' });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.tempMessageId).toBe(clientId);

    await flushOutbox({ force: true, lane: 'image' });
    expect(sentClientIds().every((id) => id === clientId)).toBe(true);
    expect(outbox).toHaveLength(0);
  });
});

describe('enqueue identity normalization', () => {
  it('does not create a second outbox row for pending-* of the same clientId', async () => {
    await enqueueTextOutbox('c', 'same-id', 'x', 'y', 'hi');
    await enqueueTextOutbox('c', 'pending-same-id', 'x', 'y', 'hi');
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.tempMessageId).toBe('same-id');
  });
});
