import { describe, expect, it } from 'vitest';
import {
  BOTTOM_THRESHOLD_PX,
  applyUnreadBelowCount,
  formatUnreadBelowBadge,
  isBottomTargetingIntent,
  measureChatViewport,
  shouldIncrementUnreadBelow,
  syncFromUserScroll,
  type ChatScrollIntent,
} from './chat-viewport';
import { reconcileMessage } from './message-reconcile';
import type { StoredMessage } from './storage';

function msg(partial: Partial<StoredMessage> & Pick<StoredMessage, 'id'>): StoredMessage {
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

function fakeScroller(partial: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): HTMLElement {
  return partial as HTMLElement;
}

describe('BOTTOM_THRESHOLD_PX', () => {
  it('stays in the agreed sticky-bottom band', () => {
    expect(BOTTOM_THRESHOLD_PX).toBeGreaterThanOrEqual(24);
    expect(BOTTOM_THRESHOLD_PX).toBeLessThanOrEqual(64);
  });
});

describe('measureChatViewport', () => {
  it('reports flush bottom', () => {
    const m = measureChatViewport(
      fakeScroller({ scrollHeight: 1000, scrollTop: 700, clientHeight: 300 }),
    );
    expect(m.distanceToBottom).toBe(0);
    expect(m.isAtBottom).toBe(true);
    expect(m.hasMessagesBelow).toBe(false);
  });

  it('isAtBottom within threshold while hasMessagesBelow stays true', () => {
    const m = measureChatViewport(
      fakeScroller({
        scrollHeight: 1000,
        scrollTop: 1000 - 300 - BOTTOM_THRESHOLD_PX,
        clientHeight: 300,
      }),
    );
    expect(m.distanceToBottom).toBe(BOTTOM_THRESHOLD_PX);
    expect(m.isAtBottom).toBe(true);
    expect(m.hasMessagesBelow).toBe(true);
  });

  it('leaves the bottom past the threshold', () => {
    const m = measureChatViewport(
      fakeScroller({
        scrollHeight: 1000,
        scrollTop: 1000 - 300 - (BOTTOM_THRESHOLD_PX + 1),
        clientHeight: 300,
      }),
    );
    expect(m.distanceToBottom).toBe(BOTTOM_THRESHOLD_PX + 1);
    expect(m.isAtBottom).toBe(false);
    expect(m.hasMessagesBelow).toBe(true);
  });

  it('clamps negative distance from overscroll', () => {
    const m = measureChatViewport(
      fakeScroller({ scrollHeight: 500, scrollTop: 250, clientHeight: 300 }),
    );
    expect(m.distanceToBottom).toBe(0);
    expect(m.isAtBottom).toBe(true);
    expect(m.hasMessagesBelow).toBe(false);
  });
});

describe('isBottomTargetingIntent', () => {
  const cases: [ChatScrollIntent, boolean][] = [
    ['none', false],
    ['initial', true],
    ['jump-to-latest', true],
    ['own-message', true],
    ['reply-target', false],
    ['history-anchor', false],
  ];
  it.each(cases)('%s → %s', (intent, expected) => {
    expect(isBottomTargetingIntent(intent)).toBe(expected);
  });
});

describe('syncFromUserScroll', () => {
  it('at bottom: follow + reset unread (observation only)', () => {
    const sync = syncFromUserScroll({
      distanceToBottom: 0,
      isAtBottom: true,
      hasMessagesBelow: false,
    });
    expect(sync).toEqual({
      isAtBottom: true,
      followBottom: true,
      resetUnreadBelow: true,
    });
  });

  it('scrolled up: stop follow, keep unread', () => {
    const sync = syncFromUserScroll({
      distanceToBottom: 200,
      isAtBottom: false,
      hasMessagesBelow: true,
    });
    expect(sync).toEqual({
      isAtBottom: false,
      followBottom: false,
      resetUnreadBelow: false,
    });
  });
});

describe('shouldIncrementUnreadBelow', () => {
  it('increments for a foreign logical insert while above the end', () => {
    expect(
      shouldIncrementUnreadBelow({
        inserted: true,
        isOwnMessage: false,
        isAtBottom: false,
      }),
    ).toBe(true);
  });

  it('does not increment at the bottom', () => {
    expect(
      shouldIncrementUnreadBelow({
        inserted: true,
        isOwnMessage: false,
        isAtBottom: true,
      }),
    ).toBe(false);
  });

  it('does not increment own message / WS echo', () => {
    expect(
      shouldIncrementUnreadBelow({
        inserted: true,
        isOwnMessage: true,
        isAtBottom: false,
      }),
    ).toBe(false);
  });

  it('does not increment when inserted is false (ACK, duplicate WS, update)', () => {
    expect(
      shouldIncrementUnreadBelow({
        inserted: false,
        isOwnMessage: false,
        isAtBottom: false,
      }),
    ).toBe(false);
  });
});

describe('applyUnreadBelowCount', () => {
  it('increments by one logical message', () => {
    expect(applyUnreadBelowCount(0, 'increment')).toBe(1);
    expect(applyUnreadBelowCount(2, 'increment')).toBe(3);
  });

  it('resets only via explicit reset action', () => {
    expect(applyUnreadBelowCount(7, 'reset')).toBe(0);
    expect(applyUnreadBelowCount(0, 'reset')).toBe(0);
  });
});

describe('formatUnreadBelowBadge', () => {
  it('hides empty count', () => {
    expect(formatUnreadBelowBadge(0)).toBe('');
  });

  it('shows exact count up to 99', () => {
    expect(formatUnreadBelowBadge(1)).toBe('1');
    expect(formatUnreadBelowBadge(99)).toBe('99');
  });

  it('collapses large values to 99+', () => {
    expect(formatUnreadBelowBadge(100)).toBe('99+');
    expect(formatUnreadBelowBadge(1000)).toBe('99+');
  });
});

describe('unreadBelowCount counts logical messages not network events', () => {
  const me = 'me';
  const aboveEnd = false;

  function bumpFromOp(
    count: number,
    result: { inserted: boolean },
    incoming: StoredMessage,
    isAtBottom = aboveEnd,
  ): number {
    if (
      shouldIncrementUnreadBelow({
        inserted: result.inserted,
        isOwnMessage: incoming.senderId === me,
        isAtBottom,
      })
    ) {
      return applyUnreadBelowCount(count, 'increment');
    }
    return count;
  }

  it('increments once per foreign logical insert while above the end', () => {
    let list: StoredMessage[] = [];
    let count = 0;

    const first = msg({ id: 'srv-1', senderId: 'peer', sequence: 1, createdAt: 10 });
    const r1 = reconcileMessage(list, first);
    list = r1.messages;
    count = bumpFromOp(count, r1, first);
    expect(count).toBe(1);

    const second = msg({ id: 'srv-2', senderId: 'peer', sequence: 2, createdAt: 20, text: 'two' });
    const r2 = reconcileMessage(list, second);
    list = r2.messages;
    count = bumpFromOp(count, r2, second);
    expect(count).toBe(2);
  });

  it('does not increment duplicate WS, HTTP ACK, own echo, or in-place update', () => {
    const pending = msg({
      id: 'pending-c1',
      clientId: 'c1',
      senderId: me,
      pending: true,
      createdAt: 5,
    });
    let list = [pending];
    let count = 0;

    // Own HTTP ACK → update, not insert
    const ack = msg({
      id: 'srv-ack',
      clientId: 'c1',
      senderId: me,
      createdAt: 5,
      sequence: 1,
    });
    const rAck = reconcileMessage(list, ack);
    list = rAck.messages;
    count = bumpFromOp(count, rAck, ack);
    expect(rAck.inserted).toBe(false);
    expect(count).toBe(0);

    // Own WS echo of the same entity
    const echo = { ...ack };
    const rEcho = reconcileMessage(list, echo);
    list = rEcho.messages;
    count = bumpFromOp(count, rEcho, echo);
    expect(rEcho.inserted).toBe(false);
    expect(count).toBe(0);

    // Foreign insert once
    const foreign = msg({ id: 'srv-f', senderId: 'peer', sequence: 2, createdAt: 20 });
    const rForeign = reconcileMessage(list, foreign);
    list = rForeign.messages;
    count = bumpFromOp(count, rForeign, foreign);
    expect(count).toBe(1);

    // Duplicate WS of that foreign message
    const dup = { ...foreign };
    const rDup = reconcileMessage(list, dup);
    list = rDup.messages;
    count = bumpFromOp(count, rDup, dup);
    expect(rDup.inserted).toBe(false);
    expect(count).toBe(1);

    // History sync / update of existing entity
    const updated = msg({
      id: 'srv-f',
      senderId: 'peer',
      sequence: 2,
      createdAt: 20,
      text: 'edited',
    });
    const rUpd = reconcileMessage(list, updated);
    count = bumpFromOp(count, rUpd, updated);
    expect(rUpd.inserted).toBe(false);
    expect(count).toBe(1);
  });

  it('does not increment while at bottom; reset only via explicit reset', () => {
    let list: StoredMessage[] = [];
    let count = 0;

    const atBottom = msg({ id: 'srv-1', senderId: 'peer', sequence: 1, createdAt: 10 });
    const r1 = reconcileMessage(list, atBottom);
    list = r1.messages;
    count = bumpFromOp(count, r1, atBottom, true);
    expect(count).toBe(0);

    const above = msg({ id: 'srv-2', senderId: 'peer', sequence: 2, createdAt: 20, text: 'x' });
    const r2 = reconcileMessage(list, above);
    count = bumpFromOp(count, r2, above, false);
    expect(count).toBe(1);

    // Focus/blur/resize/menu/storage must not call reset — count stays until ↓ / end.
    expect(count).toBe(1);
    count = applyUnreadBelowCount(count, 'reset');
    expect(count).toBe(0);
  });
});
