import { describe, expect, it } from 'vitest';
import {
  dedupeStoredMessages,
  findMessageByTempId,
  messageClientKey,
  sameMessageIdentity,
  upsertMessageInList,
} from './message-dedupe';
import { compareMessages, maxMessageSequence } from './message-upsert';
import type { StoredMessage } from './storage';

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

/** Fold a sequence of arrivals the way ChatView applies live upserts. */
function foldUpserts(initial: StoredMessage[], arrivals: StoredMessage[]): StoredMessage[] {
  let list = initial;
  for (const incoming of arrivals) {
    list = upsertMessageInList(list, incoming).next;
  }
  return list;
}

describe('dedupeStoredMessages', () => {
  it('keeps one row per clientId preferring confirmed', () => {
    const out = dedupeStoredMessages([
      msg({ id: 'pending-1', clientId: 'cid', pending: true, createdAt: 10 }),
      msg({ id: 'srv-1', clientId: 'cid', pending: false, sequence: 3, createdAt: 11 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('srv-1');
    expect(out[0]!.sequence).toBe(3);
  });

  it('dedupes by server id', () => {
    const out = dedupeStoredMessages([
      msg({ id: 'srv-1', clientId: 'a', sequence: 1, createdAt: 1 }),
      msg({ id: 'srv-1', clientId: 'a', sequence: 1, createdAt: 2, text: 'updated' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('updated');
  });
});

describe('upsertMessageInList', () => {
  it('replaces pending bubble when WS echo arrives with server id', () => {
    const pending = msg({
      id: 'pending-cid',
      clientId: 'cid',
      pending: true,
      createdAt: 10,
      text: 'hello',
    });
    const echo = msg({
      id: 'srv-1',
      clientId: 'cid',
      pending: false,
      sequence: 4,
      createdAt: 11,
      text: 'hello',
    });
    const { next, inserted, changed } = upsertMessageInList([pending], echo);
    expect(changed).toBe(true);
    expect(inserted).toBe(false);
    expect(next).toHaveLength(1);
    expect(next[0]!.id).toBe('srv-1');
    expect(next[0]!.pending).toBe(false);
  });

  it('dedupes when confirm map would leave two server rows', () => {
    const a = msg({ id: 'srv-1', clientId: 'cid', sequence: 1, createdAt: 1 });
    const b = msg({ id: 'srv-1', clientId: 'cid', sequence: 1, createdAt: 2, text: 'x' });
    const { next } = upsertMessageInList([a], b);
    expect(next).toHaveLength(1);
  });
});

describe('findMessageByTempId', () => {
  it('finds pending-${clientId} rows from bare outbox temp id', () => {
    const row = msg({ id: 'pending-abc', clientId: 'abc', pending: true });
    expect(findMessageByTempId([row], 'abc')?.id).toBe('pending-abc');
  });
});

describe('compareMessages / maxMessageSequence', () => {
  it('orders by sequence then createdAt', () => {
    const a = msg({ id: 'a', sequence: 2, createdAt: 100 });
    const b = msg({ id: 'b', sequence: 1, createdAt: 200 });
    expect(compareMessages(b, a)).toBeLessThan(0);
  });

  it('tracks max sequence', () => {
    expect(
      maxMessageSequence([
        msg({ id: '1', sequence: 2 }),
        msg({ id: '2', sequence: 9 }),
        msg({ id: '3' }),
      ]),
    ).toBe(9);
  });
});

describe('message identity invariants', () => {
  it('1. same sender + same text "Да" with different ids stay two bubbles', () => {
    const first = msg({
      id: 'srv-1',
      clientId: 'cid-1',
      senderId: 'u1',
      text: 'Да',
      createdAt: 1_000,
      sequence: 1,
    });
    const second = msg({
      id: 'srv-2',
      clientId: 'cid-2',
      senderId: 'u1',
      text: 'Да',
      createdAt: 1_100,
      sequence: 2,
    });

    expect(dedupeStoredMessages([first, second])).toHaveLength(2);
    expect(upsertMessageInList([first], second).next).toHaveLength(2);
    expect(sameMessageIdentity(first, second)).toBe(false);
  });

  it('2. three identical texts in a row stay three bubbles', () => {
    const rows = [
      msg({ id: 'srv-1', clientId: 'a', text: 'ок', createdAt: 10, sequence: 1 }),
      msg({ id: 'srv-2', clientId: 'b', text: 'ок', createdAt: 20, sequence: 2 }),
      msg({ id: 'srv-3', clientId: 'c', text: 'ок', createdAt: 30, sequence: 3 }),
    ];

    expect(dedupeStoredMessages(rows)).toHaveLength(3);
    expect(foldUpserts([], rows)).toHaveLength(3);
  });

  it('3. pending + server row with the same clientId collapse to one bubble', () => {
    const pending = msg({
      id: 'pending-cid',
      clientId: 'cid',
      pending: true,
      text: 'hello',
      createdAt: 10,
    });
    const server = msg({
      id: 'srv-1',
      clientId: 'cid',
      pending: false,
      text: 'hello',
      createdAt: 11,
      sequence: 4,
    });

    const { next, inserted } = upsertMessageInList([pending], server);
    expect(inserted).toBe(false);
    expect(next).toHaveLength(1);
    expect(next[0]!.id).toBe('srv-1');
    expect(next[0]!.pending).toBe(false);
    expect(dedupeStoredMessages([pending, server])).toHaveLength(1);
  });

  it('4. pending → HTTP ACK → WebSocket echo yields one bubble', () => {
    const clientId = 'cid-ack-ws';
    const pending = msg({
      id: `pending-${clientId}`,
      clientId,
      pending: true,
      text: 'ping',
      createdAt: 10,
    });
    const httpAck = msg({
      id: 'srv-42',
      clientId,
      pending: false,
      text: 'ping',
      createdAt: 11,
      sequence: 7,
    });
    const wsEcho = msg({
      id: 'srv-42',
      clientId,
      pending: false,
      text: 'ping',
      createdAt: 11,
      sequence: 7,
    });

    const next = foldUpserts([pending], [httpAck, wsEcho]);
    expect(next).toHaveLength(1);
    expect(next[0]!.id).toBe('srv-42');
    expect(next[0]!.clientId).toBe(clientId);
    expect(next[0]!.pending).toBe(false);
  });

  it('5. pending → WebSocket echo before HTTP ACK yields one bubble', () => {
    const clientId = 'cid-ws-ack';
    const pending = msg({
      id: `pending-${clientId}`,
      clientId,
      pending: true,
      text: 'ping',
      createdAt: 10,
    });
    const wsEcho = msg({
      id: 'srv-99',
      clientId,
      pending: false,
      text: 'ping',
      createdAt: 11,
      sequence: 8,
    });
    const httpAck = msg({
      id: 'srv-99',
      clientId,
      pending: false,
      text: 'ping',
      createdAt: 11,
      sequence: 8,
    });

    const next = foldUpserts([pending], [wsEcho, httpAck]);
    expect(next).toHaveLength(1);
    expect(next[0]!.id).toBe('srv-99');
    expect(next[0]!.pending).toBe(false);
  });

  it('6. two events with the same server id yield one bubble', () => {
    const first = msg({ id: 'srv-1', clientId: 'cid', sequence: 1, createdAt: 1, text: 'a' });
    const second = msg({ id: 'srv-1', clientId: 'cid', sequence: 1, createdAt: 2, text: 'b' });

    expect(dedupeStoredMessages([first, second])).toHaveLength(1);
    expect(upsertMessageInList([first], second).next).toHaveLength(1);
    expect(sameMessageIdentity(first, second)).toBe(true);
  });

  it('7. history sync of already-known server ids does not create duplicates', () => {
    const existing = [
      msg({ id: 'srv-1', clientId: 'a', text: 'one', sequence: 1, createdAt: 1 }),
      msg({ id: 'srv-2', clientId: 'b', text: 'two', sequence: 2, createdAt: 2 }),
    ];
    const historyBatch = [
      msg({ id: 'srv-1', clientId: 'a', text: 'one', sequence: 1, createdAt: 1 }),
      msg({ id: 'srv-2', clientId: 'b', text: 'two', sequence: 2, createdAt: 2 }),
      msg({ id: 'srv-3', clientId: 'c', text: 'three', sequence: 3, createdAt: 3 }),
    ];

    // ChatView history path: merge by server id, keep unmatched pending, then dedupe.
    const map = new Map(existing.filter((m) => !m.pending).map((m) => [m.id, m]));
    for (const m of historyBatch) map.set(m.id, m);
    expect(dedupeStoredMessages([...map.values()])).toHaveLength(3);

    // Live upsert path for the same arrivals.
    expect(foldUpserts(existing, historyBatch)).toHaveLength(3);
  });

  it('8. different clientIds never merge only because text matches', () => {
    const pendingA = msg({
      id: 'pending-a',
      clientId: 'a',
      pending: true,
      text: 'Да',
      createdAt: 10,
    });
    const pendingB = msg({
      id: 'pending-b',
      clientId: 'b',
      pending: true,
      text: 'Да',
      createdAt: 11,
    });
    const serverA = msg({
      id: 'srv-a',
      clientId: 'a',
      pending: false,
      text: 'Да',
      createdAt: 12,
      sequence: 1,
    });
    const serverB = msg({
      id: 'srv-b',
      clientId: 'b',
      pending: false,
      text: 'Да',
      createdAt: 13,
      sequence: 2,
    });

    const next = foldUpserts([], [pendingA, pendingB, serverA, serverB]);
    expect(next).toHaveLength(2);
    expect(next.map((m) => m.id).sort()).toEqual(['srv-a', 'srv-b']);
    expect(sameMessageIdentity(pendingA, pendingB)).toBe(false);
    expect(sameMessageIdentity(serverA, serverB)).toBe(false);
  });
});

describe('messageClientKey / sameMessageIdentity', () => {
  it('treats pending-${clientId}, bare clientId, and server row as one identity', () => {
    const pending = { id: 'pending-cid' };
    const withClient = { id: 'srv-1', clientId: 'cid' };
    const barePending = { id: 'pending-cid', clientId: 'cid' };

    expect(messageClientKey(pending)).toBe('cid');
    expect(messageClientKey(withClient)).toBe('cid');
    expect(sameMessageIdentity(pending, withClient)).toBe(true);
    expect(sameMessageIdentity(barePending, withClient)).toBe(true);
  });

  it('does not equate distinct server ids without a shared client key', () => {
    expect(
      sameMessageIdentity({ id: 'srv-1', clientId: 'a' }, { id: 'srv-2', clientId: 'b' }),
    ).toBe(false);
    expect(sameMessageIdentity({ id: 'srv-1' }, { id: 'srv-2' })).toBe(false);
  });
});

/**
 * Known gap: legacy dedupe collapses no-clientId rows by sender/type/text within 5s.
 * Correct identity model: distinct server ids are distinct messages even with identical text.
 */
describe('known legacy identity gaps', () => {
  it.fails(
    'same text + different server ids without clientId must stay two bubbles',
    () => {
      const a = msg({
        id: 'srv-1',
        senderId: 'u1',
        text: 'Да',
        createdAt: 1_000,
        sequence: 1,
      });
      const b = msg({
        id: 'srv-2',
        senderId: 'u1',
        text: 'Да',
        createdAt: 1_500,
        sequence: 2,
      });
      expect(dedupeStoredMessages([a, b])).toHaveLength(2);
    },
  );

  it.fails(
    'three identical texts without clientId within 5s must stay three bubbles',
    () => {
      const rows = [
        msg({ id: 'srv-1', text: 'Да', createdAt: 1_000, sequence: 1 }),
        msg({ id: 'srv-2', text: 'Да', createdAt: 1_100, sequence: 2 }),
        msg({ id: 'srv-3', text: 'Да', createdAt: 1_200, sequence: 3 }),
      ];
      expect(dedupeStoredMessages(rows)).toHaveLength(3);
    },
  );
});
