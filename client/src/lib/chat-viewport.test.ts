import { describe, expect, it } from 'vitest';
import {
  BOTTOM_THRESHOLD_PX,
  applyUnreadBelowCount,
  composerResizeSync,
  createRafCoalescer,
  followBottomOutcome,
  formatUnreadBelowBadge,
  incomingScrollPolicy,
  isBottomTargetingIntent,
  measureChatViewport,
  shouldFollowBottomOnMediaLayout,
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

describe('incomingScrollPolicy (TASK-014)', () => {
  it('follows only when the user was at the bottom before upsert', () => {
    expect(incomingScrollPolicy(true)).toBe('follow-bottom');
  });

  it('preserves scroll when the user was reading above the end', () => {
    expect(incomingScrollPolicy(false)).toBe('preserve');
  });

  it('treats messages-array change as non-scroll: preserve ⇒ no bottom pin', () => {
    // Changing messages is not a scroll command — preserve policy must not
    // imply follow-bottom / scrollToEnd / scrollIntoView / history-anchor.
    const policy = incomingScrollPolicy(false);
    expect(policy).not.toBe('follow-bottom');
    expect(policy).toBe('preserve');
  });

  it('regression: append-below history-anchor compensation would yank the reader', () => {
    // User reading ~30 messages above the end; 10 messages append below.
    // Browser keeps scrollTop stable on append. Applying the old
    // `top + (newHeight - oldHeight)` compensation would scroll DOWN by the
    // appended height and tear the user off the message they were reading.
    const scrollTopBefore = 1000;
    const heightBefore = 3000;
    const appendedHeight = 500; // ~10 messages
    const heightAfter = heightBefore + appendedHeight;
    const wronglyCompensated = scrollTopBefore + (heightAfter - heightBefore);
    const preserveScrollTop = scrollTopBefore;

    expect(wronglyCompensated).toBe(1500);
    expect(preserveScrollTop).toBe(1000);
    expect(incomingScrollPolicy(false)).toBe('preserve');
    // preserve must keep the pre-upsert scrollTop, not the compensated value.
    expect(preserveScrollTop).not.toBe(wronglyCompensated);
  });
});

describe('incomingScrollPolicy composer focus (TASK-016)', () => {
  it('preserves scroll while composer is focused even at the end', () => {
    expect(incomingScrollPolicy(true, true)).toBe('preserve');
  });

  it('preserves scroll while composer is focused above the end', () => {
    expect(incomingScrollPolicy(false, true)).toBe('preserve');
  });

  it('still follows at the end when composer is idle', () => {
    expect(incomingScrollPolicy(true, false)).toBe('follow-bottom');
  });
});

describe('shouldFollowBottomOnMediaLayout (TASK-016 / TASK-017)', () => {
  it('pins when follow is armed, composer idle, and content grew', () => {
    expect(
      shouldFollowBottomOnMediaLayout({
        followBottom: true,
        composerFocused: false,
        contentGrew: true,
        viewportResized: false,
      }),
    ).toBe(true);
  });

  it('suppresses content-only growth while composer is focused', () => {
    expect(
      shouldFollowBottomOnMediaLayout({
        followBottom: true,
        composerFocused: true,
        contentGrew: true,
        viewportResized: false,
      }),
    ).toBe(false);
  });

  it('does not pin on viewport resize while composing (textarea autoresize)', () => {
    expect(
      shouldFollowBottomOnMediaLayout({
        followBottom: true,
        composerFocused: true,
        contentGrew: false,
        viewportResized: true,
      }),
    ).toBe(false);
  });

  it('does not pin when both content and viewport change while composing', () => {
    expect(
      shouldFollowBottomOnMediaLayout({
        followBottom: true,
        composerFocused: true,
        contentGrew: true,
        viewportResized: true,
      }),
    ).toBe(false);
  });

  it('does not pin on viewport-only resize even when composer is idle', () => {
    // Keyboard / chrome / leftover autoresize — remeasure only, no scrollToEnd.
    expect(
      shouldFollowBottomOnMediaLayout({
        followBottom: true,
        composerFocused: false,
        contentGrew: false,
        viewportResized: true,
      }),
    ).toBe(false);
  });

  it('never pins when followBottom is off', () => {
    expect(
      shouldFollowBottomOnMediaLayout({
        followBottom: false,
        composerFocused: false,
        contentGrew: true,
        viewportResized: true,
      }),
    ).toBe(false);
  });
});

describe('composerResizeSync (TASK-017)', () => {
  it('never scrolls or mutates intent — only remeasures isAtBottom', () => {
    const sync = composerResizeSync();
    expect(sync.scrollToBottom).toBe(false);
    expect(sync.mutateScrollIntent).toBe(false);
    expect(sync.remeasureIsAtBottom).toBe(true);
  });

  it('composer grow can flip isAtBottom without a scroll command', () => {
    // Flush at bottom before resize.
    const before = measureChatViewport(
      fakeScroller({ scrollHeight: 1000, scrollTop: 700, clientHeight: 300 }),
    );
    expect(before.isAtBottom).toBe(true);
    expect(before.distanceToBottom).toBe(0);

    // Composer grows ~80px → `.messages` clientHeight shrinks; scrollTop unchanged.
    const after = measureChatViewport(
      fakeScroller({ scrollHeight: 1000, scrollTop: 700, clientHeight: 220 }),
    );
    expect(after.distanceToBottom).toBe(80);
    expect(after.isAtBottom).toBe(false);

    // Media-layout must not schedule a pin for this viewport-only change.
    expect(
      shouldFollowBottomOnMediaLayout({
        followBottom: true,
        composerFocused: true,
        contentGrew: false,
        viewportResized: true,
      }),
    ).toBe(false);
    // ↓ reflects the post-resize fact; follow/intent stay caller-owned.
    expect(composerResizeSync().scrollToBottom).toBe(false);
    expect(composerResizeSync().mutateScrollIntent).toBe(false);
  });

  it('small grow within threshold still counts as at bottom', () => {
    const after = measureChatViewport(
      fakeScroller({
        scrollHeight: 1000,
        scrollTop: 700,
        clientHeight: 300 - (BOTTOM_THRESHOLD_PX - 1),
      }),
    );
    expect(after.distanceToBottom).toBe(BOTTOM_THRESHOLD_PX - 1);
    expect(after.isAtBottom).toBe(true);
  });
});

describe('follow-bottom outcome (TASK-015)', () => {
  it('keeps message visible without ↓ or unread bump', () => {
    const outcome = followBottomOutcome();
    expect(outcome.policy).toBe('follow-bottom');
    expect(outcome.followBottom).toBe(true);
    expect(outcome.pinToBottom).toBe(true);
    expect(outcome.showScrollDown).toBe(false);
    expect(outcome.incrementUnreadBelow).toBe(false);
  });

  it('pairs with policy + unread helpers for an at-end foreign insert', () => {
    const wasAtBottom = true;
    expect(incomingScrollPolicy(wasAtBottom)).toBe('follow-bottom');
    expect(
      shouldIncrementUnreadBelow({
        inserted: true,
        isOwnMessage: false,
        isAtBottom: wasAtBottom,
      }),
    ).toBe(false);
    expect(followBottomOutcome().showScrollDown).toBe(false);
  });

  it('burst of at-end inserts never bumps unreadBelowCount', () => {
    let count = 0;
    for (let i = 0; i < 25; i++) {
      const wasAtBottom = true;
      if (incomingScrollPolicy(wasAtBottom) === 'follow-bottom') {
        // follow-bottom path must not call increment
        expect(followBottomOutcome().incrementUnreadBelow).toBe(false);
        continue;
      }
      count = applyUnreadBelowCount(count, 'increment');
    }
    expect(count).toBe(0);
  });
});

describe('createRafCoalescer (TASK-015 burst scroll)', () => {
  it('runs one callback for many schedule calls in the same frame', () => {
    const queued: FrameRequestCallback[] = [];
    let nextId = 1;
    const coalescer = createRafCoalescer(
      (cb) => {
        queued.push(cb);
        return nextId++;
      },
      () => {
        queued.length = 0;
      },
    );

    let runs = 0;
    expect(coalescer.schedule(() => {
      runs += 1;
    })).toBe(true);
    expect(coalescer.pending).toBe(true);
    expect(coalescer.schedule(() => {
      runs += 1;
    })).toBe(false);
    expect(coalescer.schedule(() => {
      runs += 1;
    })).toBe(false);
    expect(queued).toHaveLength(1);

    const first = queued.shift()!;
    first(0);
    expect(runs).toBe(1);
    expect(coalescer.pending).toBe(false);

    // After the frame fires, a new schedule is allowed.
    expect(coalescer.schedule(() => {
      runs += 1;
    })).toBe(true);
    expect(queued).toHaveLength(1);
    queued[0](0);
    expect(runs).toBe(2);
  });

  it('cancel drops a pending frame without running it', () => {
    let id = 0;
    let cancelled = 0;
    const coalescer = createRafCoalescer(
      (cb) => {
        id += 1;
        void cb;
        return id;
      },
      () => {
        cancelled += 1;
      },
    );
    let runs = 0;
    coalescer.schedule(() => {
      runs += 1;
    });
    coalescer.cancel();
    expect(cancelled).toBe(1);
    expect(coalescer.pending).toBe(false);
    expect(runs).toBe(0);
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
