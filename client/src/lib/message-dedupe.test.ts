import { describe, expect, it } from 'vitest';
import { dedupeStoredMessages } from './message-dedupe';
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
