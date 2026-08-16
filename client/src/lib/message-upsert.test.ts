import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredMessage } from './storage';

const getMessages = vi.fn();
const getMessage = vi.fn();
const saveMessage = vi.fn();
const replacePendingMessage = vi.fn();
const removeOutboxByTempMessageId = vi.fn();

vi.mock('./storage', () => ({
  getMessages: (...args: unknown[]) => getMessages(...args),
  getMessage: (...args: unknown[]) => getMessage(...args),
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

/** Snapshot comparable final entity fields (ignore object identity). */
function finalState(rows: StoredMessage[]) {
  return rows.map((m) => ({
    id: m.id,
    clientId: m.clientId,
    pending: !!m.pending,
    text: m.text,
    sequence: m.sequence,
    createdAt: m.createdAt,
  }));
}

describe('upsertStoredMessage identity', () => {
  let store: StoredMessage[];

  beforeEach(() => {
    store = [];
    getMessages.mockReset();
    getMessage.mockReset();
    saveMessage.mockReset();
    replacePendingMessage.mockReset();
    removeOutboxByTempMessageId.mockReset();

    getMessages.mockImplementation(async () => [...store]);
    getMessage.mockImplementation(async (id: string) => store.find((row) => row.id === id));
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

  it('peer insert looks up by id and skips a full chat scan', async () => {
    await upsertStoredMessage(msg({ id: 'srv-new', senderId: 'u2', text: 'hi', sequence: 1 }));
    expect(getMessage).toHaveBeenCalledWith('srv-new');
    expect(getMessages).not.toHaveBeenCalled();
    expect(store).toHaveLength(1);
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

/**
 * TASK-006: HTTP ACK and WebSocket share upsertStoredMessage.
 * Both arrival orders must converge on one entity (id + clientId).
 */
describe('HTTP ACK canonical upsert (TASK-006)', () => {
  let store: StoredMessage[];

  beforeEach(() => {
    store = [];
    getMessages.mockReset();
    getMessage.mockReset();
    saveMessage.mockReset();
    replacePendingMessage.mockReset();
    removeOutboxByTempMessageId.mockReset();

    getMessages.mockImplementation(async () => [...store]);
    getMessage.mockImplementation(async (id: string) => store.find((row) => row.id === id));
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

  async function seedPending(clientId: string) {
    const pending = msg({
      id: `pending-${clientId}`,
      clientId,
      pending: true,
      text: 'hello',
      createdAt: 10,
    });
    store.push(pending);
    return pending;
  }

  function serverPayload(clientId: string) {
    return msg({
      id: '500',
      clientId,
      pending: false,
      text: 'hello',
      createdAt: 11,
      sequence: 9,
    });
  }

  it('HTTP → WS: pending clientId=A becomes id=500,clientId=A; WS creates nothing new', async () => {
    const clientId = 'A';
    await seedPending(clientId);
    const httpAck = serverPayload(clientId);
    const wsEcho = serverPayload(clientId);

    const afterHttp = await upsertStoredMessage(httpAck);
    expect(store).toHaveLength(1);
    expect(afterHttp.id).toBe('500');
    expect(afterHttp.clientId).toBe('A');
    expect(afterHttp.pending).toBe(false);

    const afterWs = await upsertStoredMessage(wsEcho);
    expect(store).toHaveLength(1);
    expect(afterWs.id).toBe('500');
    expect(afterWs.clientId).toBe('A');
    expect(finalState(store)).toEqual([
      { id: '500', clientId: 'A', pending: false, text: 'hello', sequence: 9, createdAt: 11 },
    ]);
  });

  it('WS → HTTP: WS confirms first; HTTP ACK creates nothing new', async () => {
    const clientId = 'A';
    await seedPending(clientId);
    const wsEcho = serverPayload(clientId);
    const httpAck = serverPayload(clientId);

    const afterWs = await upsertStoredMessage(wsEcho);
    expect(store).toHaveLength(1);
    expect(afterWs.id).toBe('500');
    expect(afterWs.clientId).toBe('A');

    const afterHttp = await upsertStoredMessage(httpAck);
    expect(store).toHaveLength(1);
    expect(afterHttp.id).toBe('500');
    expect(afterHttp.clientId).toBe('A');
    expect(finalState(store)).toEqual([
      { id: '500', clientId: 'A', pending: false, text: 'hello', sequence: 9, createdAt: 11 },
    ]);
  });

  it('both orders converge on the same final message state', async () => {
    const clientId = 'A';
    const payload = serverPayload(clientId);

    // Order 1: HTTP → WS
    store = [];
    await seedPending(clientId);
    await upsertStoredMessage(payload);
    await upsertStoredMessage(payload);
    const httpFirst = finalState(store);

    // Order 2: WS → HTTP
    store = [];
    await seedPending(clientId);
    await upsertStoredMessage(payload);
    await upsertStoredMessage(payload);
    const wsFirst = finalState(store);

    expect(httpFirst).toEqual(wsFirst);
    expect(httpFirst).toHaveLength(1);
    expect(httpFirst[0]).toMatchObject({ id: '500', clientId: 'A', pending: false });
  });
});
