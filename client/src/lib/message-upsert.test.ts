import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredMessage } from './storage';

const getMessages = vi.fn();
const saveMessage = vi.fn();
const replacePendingMessage = vi.fn();
const removeOutboxByTempMessageId = vi.fn();

vi.mock('./storage', () => ({
  getMessages: (...args: unknown[]) => getMessages(...args),
  saveMessage: (...args: unknown[]) => saveMessage(...args),
  replacePendingMessage: (...args: unknown[]) => replacePendingMessage(...args),
  removeOutboxByTempMessageId: (...args: unknown[]) => removeOutboxByTempMessageId(...args),
}));

const { upsertStoredMessage } = await import('./message-upsert');

function msg(partial: Partial<StoredMessage> & Pick<StoredMessage, 'id'>): StoredMessage {
  return {
    chatId: 'c1',
    senderId: 'u1',
    senderName: 'A',
    text: 'hi',
    type: 'text',
    createdAt: 1,
    ...partial,
  };
}

describe('upsertStoredMessage identity', () => {
  let store: StoredMessage[];

  beforeEach(() => {
    store = [];
    getMessages.mockReset();
    saveMessage.mockReset();
    replacePendingMessage.mockReset();
    removeOutboxByTempMessageId.mockReset();

    getMessages.mockImplementation(async () => [...store]);
    saveMessage.mockImplementation(async (m: StoredMessage) => {
      const idx = store.findIndex((row) => row.id === m.id);
      if (idx >= 0) store[idx] = m;
      else store.push(m);
    });
    replacePendingMessage.mockImplementation(async (tempId: string, message: StoredMessage) => {
      store = store.filter(
        (row) =>
          row.id !== tempId &&
          row.id !== `pending-${tempId.replace(/^pending-/, '')}` &&
          !(
            row.pending &&
            (row.clientId === message.clientId ||
              row.id === message.clientId ||
              row.id === `pending-${message.clientId}`)
          ),
      );
      store.push({ ...message, pending: false, failed: false, error: undefined });
    });
    removeOutboxByTempMessageId.mockResolvedValue(true);
  });

  it('pending + HTTP ACK + WebSocket echo persist as one row', async () => {
    const clientId = 'cid-persist';
    store.push(
      msg({
        id: `pending-${clientId}`,
        clientId,
        pending: true,
        text: 'ping',
        createdAt: 10,
      }),
    );

    const ack = msg({
      id: 'srv-1',
      clientId,
      pending: false,
      text: 'ping',
      createdAt: 11,
      sequence: 3,
    });
    await upsertStoredMessage(ack);
    expect(store).toHaveLength(1);
    expect(store[0]!.id).toBe('srv-1');

    const echo = msg({
      id: 'srv-1',
      clientId,
      pending: false,
      text: 'ping',
      createdAt: 11,
      sequence: 3,
    });
    await upsertStoredMessage(echo);
    expect(store).toHaveLength(1);
    expect(store[0]!.id).toBe('srv-1');
  });

  it('WebSocket echo before HTTP ACK still leaves one row', async () => {
    const clientId = 'cid-ws-first';
    store.push(
      msg({
        id: `pending-${clientId}`,
        clientId,
        pending: true,
        text: 'ping',
        createdAt: 10,
      }),
    );

    const echo = msg({
      id: 'srv-2',
      clientId,
      pending: false,
      text: 'ping',
      createdAt: 11,
      sequence: 4,
    });
    await upsertStoredMessage(echo);
    expect(store).toHaveLength(1);
    expect(store[0]!.id).toBe('srv-2');

    const ack = msg({
      id: 'srv-2',
      clientId,
      pending: false,
      text: 'ping',
      createdAt: 11,
      sequence: 4,
    });
    await upsertStoredMessage(ack);
    expect(store).toHaveLength(1);
    expect(store[0]!.id).toBe('srv-2');
  });

  it('history sync of an existing server id does not insert a duplicate row', async () => {
    store.push(
      msg({ id: 'srv-1', clientId: 'a', text: 'one', sequence: 1, createdAt: 1 }),
    );

    await upsertStoredMessage(
      msg({ id: 'srv-1', clientId: 'a', text: 'one', sequence: 1, createdAt: 1 }),
    );
    expect(store).toHaveLength(1);

    await upsertStoredMessage(
      msg({ id: 'srv-2', clientId: 'b', text: 'two', sequence: 2, createdAt: 2 }),
    );
    expect(store.map((m) => m.id).sort()).toEqual(['srv-1', 'srv-2']);
  });

  it('two different clientIds with the same text stay two rows', async () => {
    await upsertStoredMessage(
      msg({ id: 'srv-a', clientId: 'a', text: 'Да', sequence: 1, createdAt: 1 }),
    );
    await upsertStoredMessage(
      msg({ id: 'srv-b', clientId: 'b', text: 'Да', sequence: 2, createdAt: 2 }),
    );
    expect(store).toHaveLength(2);
  });
});
