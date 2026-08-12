import { describe, expect, it } from 'vitest';
import type { RawMessage } from './api';
import type { StoredMessage } from './storage';
import {
  findMatchingPending,
  hasUsablePlaintext,
  historyFetchMode,
  indexMessagesById,
  isDecryptPlaceholder,
  maxMessageSequence,
  minMessageSequence,
  pageMayHaveOlder,
  shouldReuseCachedMessage,
  sliceRecentMessages,
  takeOlderChunk,
  HISTORY_INITIAL_WINDOW,
  HISTORY_PAGE_SIZE,
} from './chat-history-sync';

function stored(partial: Partial<StoredMessage> & Pick<StoredMessage, 'id'>): StoredMessage {
  return {
    chatId: 'c1',
    senderId: 'peer',
    senderName: 'Peer',
    text: 'hi',
    type: 'text',
    createdAt: 1,
    ...partial,
  };
}

function raw(partial: Partial<RawMessage> & Pick<RawMessage, 'id'>): RawMessage {
  return {
    chatId: 'c1',
    senderId: 'peer',
    ciphertext: 'cipher',
    iv: 'iv',
    type: 'text',
    createdAt: 1,
    ...partial,
  };
}

describe('chat-history-sync', () => {
  it('detects decrypt placeholders', () => {
    expect(isDecryptPlaceholder('[не удалось расшифровать]')).toBe(true);
    expect(isDecryptPlaceholder('[ваше сообщение]')).toBe(true);
    expect(isDecryptPlaceholder('hello')).toBe(false);
    expect(hasUsablePlaintext(stored({ id: '1', text: 'ok' }))).toBe(true);
    expect(hasUsablePlaintext(stored({ id: '2', text: '[не удалось расшифровать]' }))).toBe(false);
  });

  it('reuses peer plaintext cache (not only own messages)', () => {
    const existing = stored({ id: 'm1', senderId: 'peer', text: 'cached peer' });
    expect(shouldReuseCachedMessage(existing, raw({ id: 'm1', senderId: 'peer' }))).toBe(true);
    expect(
      shouldReuseCachedMessage(
        stored({ id: 'm1', text: '[не удалось расшифровать]' }),
        raw({ id: 'm1' }),
      ),
    ).toBe(false);
    expect(shouldReuseCachedMessage(stored({ id: 'm1', pending: true }), raw({ id: 'm1' }))).toBe(
      false,
    );
  });

  it('rejects image cache when imageId changed', () => {
    const existing = stored({
      id: 'm1',
      type: 'image',
      imageId: 'img-a',
      text: '📷 Изображение',
    });
    expect(
      shouldReuseCachedMessage(existing, raw({ id: 'm1', type: 'image', imageId: 'img-b' })),
    ).toBe(false);
    expect(
      shouldReuseCachedMessage(existing, raw({ id: 'm1', type: 'image', imageId: 'img-a' })),
    ).toBe(true);
  });

  it('picks incremental vs latest fetch mode', () => {
    expect(historyFetchMode([])).toBe('latest');
    expect(historyFetchMode([stored({ id: '1', sequence: 0 })])).toBe('latest');
    expect(historyFetchMode([stored({ id: '1', sequence: 12 })])).toBe('incremental');
  });

  it('computes sequence bounds and indexes', () => {
    const msgs = [
      stored({ id: 'a', sequence: 3 }),
      stored({ id: 'b', sequence: 9 }),
      stored({ id: 'c' }),
    ];
    expect(maxMessageSequence(msgs)).toBe(9);
    expect(minMessageSequence(msgs)).toBe(3);
    expect(indexMessagesById(msgs).get('b')?.sequence).toBe(9);
  });

  it('slices recent window and older chunks', () => {
    const msgs = Array.from({ length: HISTORY_INITIAL_WINDOW + 40 }, (_, i) =>
      stored({ id: `m${i}`, createdAt: i, sequence: i + 1 }),
    );
    const { visible, older } = sliceRecentMessages(msgs);
    expect(visible).toHaveLength(HISTORY_INITIAL_WINDOW);
    expect(older).toHaveLength(40);
    expect(visible[0]!.id).toBe('m40');
    expect(visible.at(-1)!.id).toBe(`m${HISTORY_INITIAL_WINDOW + 39}`);

    const { chunk, remaining } = takeOlderChunk(older, 10);
    expect(chunk).toHaveLength(10);
    expect(remaining).toHaveLength(30);
    expect(chunk[0]!.id).toBe('m30');
  });

  it('matches pending ACK by clientId', () => {
    const pending = stored({
      id: 'pending-cid',
      clientId: 'cid',
      senderId: 'me',
      pending: true,
    });
    expect(
      findMatchingPending(
        [pending],
        raw({ id: 'srv', senderId: 'me', clientId: 'cid' }),
        'me',
      )?.id,
    ).toBe('pending-cid');
    expect(findMatchingPending([pending], raw({ id: 'srv', senderId: 'peer' }), 'me')).toBeUndefined();
  });

  it('detects full pages that may have older history', () => {
    expect(pageMayHaveOlder(HISTORY_PAGE_SIZE)).toBe(true);
    expect(pageMayHaveOlder(HISTORY_PAGE_SIZE - 1)).toBe(false);
  });
});
