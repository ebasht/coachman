// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  BOTTOM_THRESHOLD_PX,
  applyUnreadBelowCount,
  applyUnreadBelowDelta,
  applyVisualScrollAnchor,
  captureVisualScrollAnchor,
  compensatedScrollTop,
  composerResizeSync,
  createRafCoalescer,
  deleteScrollPolicy,
  followBottomOutcome,
  formatUnreadBelowBadge,
  incomingScrollPolicy,
  isBottomTargetingIntent,
  measureChatViewport,
  planBurstIncomingScroll,
  shouldArmOwnMessageScroll,
  shouldBumpUnreadBelowForIncoming,
  shouldFollowBottomForIncomingOwnMessage,
  shouldFollowBottomOnMediaLayout,
  shouldIncrementUnreadBelow,
  syncFromUserScroll,
  visualViewportResizeSync,
  type ChatScrollIntent,
  type OwnMessageScrollSource,
  type VisualScrollAnchor,
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

describe('own-message scroll intent (TASK-022)', () => {
  const cases: [OwnMessageScrollSource, boolean][] = [
    ['user-send', true],
    ['http-ack', false],
    ['ws-echo', false],
    ['persistence', false],
    ['status', false],
  ];
  it.each(cases)('%s arms own-message scroll → %s', (source, expected) => {
    expect(shouldArmOwnMessageScroll(source)).toBe(expected);
  });

  it('never re-arms follow-bottom for incoming own WS echoes', () => {
    expect(shouldFollowBottomForIncomingOwnMessage()).toBe(false);
  });

  it('user-send is the only bottom-targeting own-message source', () => {
    expect(shouldArmOwnMessageScroll('user-send')).toBe(true);
    expect(isBottomTargetingIntent('own-message')).toBe(true);
    for (const source of ['http-ack', 'ws-echo', 'persistence', 'status'] as const) {
      expect(shouldArmOwnMessageScroll(source)).toBe(false);
    }
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


describe('deleteScrollPolicy / compensatedScrollTop (TASK-041)', () => {
  it('pins when the user was at the bottom (incl. last message)', () => {
    expect(
      deleteScrollPolicy({ wasAtBottom: true, removedAboveViewport: false }),
    ).toBe('follow-bottom');
    expect(
      deleteScrollPolicy({ wasAtBottom: true, removedAboveViewport: true }),
    ).toBe('follow-bottom');
  });

  it('anchors when a message above the viewport is removed', () => {
    expect(
      deleteScrollPolicy({ wasAtBottom: false, removedAboveViewport: true }),
    ).toBe('history-anchor');
  });

  it('preserves scrollTop when removal is in/below the viewport', () => {
    expect(
      deleteScrollPolicy({ wasAtBottom: false, removedAboveViewport: false }),
    ).toBe('preserve');
  });

  it('height-delta compensation keeps the readable Y after delete-above', () => {
    const scrollTopBefore = 1200;
    const heightBefore = 4000;
    const deletedHeight = 180;
    const heightAfter = heightBefore - deletedHeight;
    expect(compensatedScrollTop(scrollTopBefore, heightBefore, heightAfter)).toBe(1020);
  });

  it('prepend (positive delta) still compensates upward', () => {
    expect(compensatedScrollTop(800, 2000, 2600)).toBe(1400);
  });
});

describe('planBurstIncomingScroll / applyUnreadBelowDelta (TASK-042)', () => {
  it('coalesces follow-bottom to a single scroll adjustment for N inserts', () => {
    const plan = planBurstIncomingScroll(true, 50);
    expect(plan.policy).toBe('follow-bottom');
    expect(plan.scrollAdjustments).toBe(1);
  });

  it('preserves viewport for burst while reading history — zero scroll adjustments', () => {
    const plan = planBurstIncomingScroll(false, 50);
    expect(plan.policy).toBe('preserve');
    expect(plan.scrollAdjustments).toBe(0);
  });

  it('ACK-only / update-only batch never pins (own ACK → no second scroll)', () => {
    expect(planBurstIncomingScroll(true, 0)).toEqual({
      policy: 'preserve',
      scrollAdjustments: 0,
    });
  });

  it('unread badge counts logical inserts, not network events', () => {
    expect(applyUnreadBelowDelta(0, 20)).toBe(20);
    expect(applyUnreadBelowDelta(5, 0)).toBe(5);
    expect(formatUnreadBelowBadge(applyUnreadBelowDelta(0, 20))).toBe('20');
  });

  it('composer focus / open menu force preserve even at bottom', () => {
    expect(planBurstIncomingScroll(true, 10, true, false).scrollAdjustments).toBe(0);
    expect(planBurstIncomingScroll(true, 10, false, true).scrollAdjustments).toBe(0);
  });

  it('MOB-011 / MOB-055 / MOB-066: typing/menu at bottom still bumps unread badge', () => {
    const typing = planBurstIncomingScroll(true, 3, true, false);
    expect(typing.scrollAdjustments).toBe(0);
    expect(
      shouldBumpUnreadBelowForIncoming({
        foreignInserted: 3,
        scrollAdjustments: typing.scrollAdjustments,
      }),
    ).toBe(true);
    expect(formatUnreadBelowBadge(applyUnreadBelowDelta(0, 3))).toBe('3');

    const menuOpen = planBurstIncomingScroll(true, 1, false, true);
    expect(
      shouldBumpUnreadBelowForIncoming({
        foreignInserted: 1,
        scrollAdjustments: menuOpen.scrollAdjustments,
      }),
    ).toBe(true);

    const follow = planBurstIncomingScroll(true, 5, false, false);
    expect(
      shouldBumpUnreadBelowForIncoming({
        foreignInserted: 5,
        scrollAdjustments: follow.scrollAdjustments,
      }),
    ).toBe(false);
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

describe('incomingScrollPolicy context menu (TASK-040)', () => {
  it('preserves scrollTop while the message menu is open at bottom', () => {
    expect(incomingScrollPolicy(true, false, true)).toBe('preserve');
  });

  it('preserves while reading history with menu open', () => {
    expect(incomingScrollPolicy(false, false, true)).toBe('preserve');
  });

  it('still follows when menu is closed and at bottom', () => {
    expect(incomingScrollPolicy(true, false, false)).toBe('follow-bottom');
  });
});

describe('shouldFollowBottomOnMediaLayout (TASK-016 / TASK-017 / TASK-020)', () => {
  it('pins when follow is armed, composer idle, content grew, and was at bottom', () => {
    expect(
      shouldFollowBottomOnMediaLayout({
        followBottom: true,
        composerFocused: false,
        contentGrew: true,
        viewportResized: false,
        wasAtBottom: true,
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
        wasAtBottom: true,
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
        wasAtBottom: true,
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
        wasAtBottom: true,
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
        wasAtBottom: true,
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
        wasAtBottom: true,
      }),
    ).toBe(false);
  });

  it('never pins while keyboard / visualViewport shell is active (TASK-018)', () => {
    expect(
      shouldFollowBottomOnMediaLayout({
        followBottom: true,
        composerFocused: false,
        contentGrew: true,
        viewportResized: true,
        keyboardShellActive: true,
        wasAtBottom: true,
      }),
    ).toBe(false);
  });

  it('does not pin on keyboard viewport-only resize while shell active', () => {
    expect(
      shouldFollowBottomOnMediaLayout({
        followBottom: true,
        composerFocused: true,
        contentGrew: false,
        viewportResized: true,
        keyboardShellActive: true,
        wasAtBottom: true,
      }),
    ).toBe(false);
  });

  it('TASK-020: followBottom alone does not pin when user was reading history', () => {
    // ResizeObserver must not be a hidden scrollToBottom while reading.
    expect(
      shouldFollowBottomOnMediaLayout({
        followBottom: true,
        composerFocused: false,
        contentGrew: true,
        viewportResized: false,
        wasAtBottom: false,
      }),
    ).toBe(false);
  });

  it('TASK-020: undefined wasAtBottom keeps prior pin behavior for content growth', () => {
    expect(
      shouldFollowBottomOnMediaLayout({
        followBottom: true,
        composerFocused: false,
        contentGrew: true,
        viewportResized: false,
      }),
    ).toBe(true);
  });

  it('TASK-040: does not pin while message context menu is open', () => {
    expect(
      shouldFollowBottomOnMediaLayout({
        followBottom: true,
        composerFocused: false,
        contentGrew: true,
        viewportResized: false,
        wasAtBottom: true,
        contextMenuOpen: true,
      }),
    ).toBe(false);
  });
});

describe('visualViewportResizeSync (TASK-018)', () => {
  it('never scrolls or mutates follow/intent — only remeasures and preserves scrollTop', () => {
    const sync = visualViewportResizeSync();
    expect(sync.scrollToBottom).toBe(false);
    expect(sync.mutateScrollIntent).toBe(false);
    expect(sync.mutateFollowBottom).toBe(false);
    expect(sync.remeasureIsAtBottom).toBe(true);
    expect(sync.preserveScrollTop).toBe(true);
  });

  it('keyboard open shrinks clientHeight without authorizing a bottom pin', () => {
    // User reading above the end — focus composer → IME opens → .messages shrinks.
    const beforeTop = 400;
    const before = measureChatViewport(
      fakeScroller({ scrollHeight: 2000, scrollTop: beforeTop, clientHeight: 500 }),
    );
    expect(before.isAtBottom).toBe(false);

    // visualViewport shell applies --app-height; scrollTop must stay put.
    const after = measureChatViewport(
      fakeScroller({ scrollHeight: 2000, scrollTop: beforeTop, clientHeight: 280 }),
    );
    expect(after.distanceToBottom).toBeGreaterThan(before.distanceToBottom);
    expect(
      shouldFollowBottomOnMediaLayout({
        followBottom: true,
        composerFocused: true,
        contentGrew: false,
        viewportResized: true,
        keyboardShellActive: true,
      }),
    ).toBe(false);
    expect(visualViewportResizeSync().scrollToBottom).toBe(false);
    expect(visualViewportResizeSync().preserveScrollTop).toBe(true);
    // Logical position = locked scrollTop, not chase-to-end.
    expect(beforeTop).toBe(400);
  });

  it('keyboard close settle with contentGrew still must not pin', () => {
    // Blur clears composerFocused before vv shell finishes settling; a coincident
    // scrollHeight bump must not become scrollToBottom permission.
    expect(
      shouldFollowBottomOnMediaLayout({
        followBottom: true,
        composerFocused: false,
        contentGrew: true,
        viewportResized: true,
        keyboardShellActive: true,
      }),
    ).toBe(false);
  });

  it('orientation / viewport resize without keyboard shell stays viewport-only', () => {
    expect(
      shouldFollowBottomOnMediaLayout({
        followBottom: true,
        composerFocused: false,
        contentGrew: false,
        viewportResized: true,
        keyboardShellActive: false,
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

describe('visual scroll anchor (TASK-019 / TASK-021)', () => {
  function stubRect(el: Element, rect: Partial<DOMRect>) {
    const full: DOMRect = {
      x: 0,
      y: rect.top ?? 0,
      width: rect.width ?? 100,
      height: rect.height ?? 40,
      top: rect.top ?? 0,
      right: (rect.left ?? 0) + (rect.width ?? 100),
      bottom: (rect.top ?? 0) + (rect.height ?? 40),
      left: rect.left ?? 0,
      toJSON() {
        return this;
      },
    };
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => full,
    });
  }

  function makeScroller(opts: {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    messages: { id: string; top: number; height: number }[];
  }): HTMLElement {
    const scroller = document.createElement('div');
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      writable: true,
      value: opts.scrollTop,
    });
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      value: opts.scrollHeight,
    });
    Object.defineProperty(scroller, 'clientHeight', {
      configurable: true,
      value: opts.clientHeight,
    });
    stubRect(scroller, { top: 100, height: opts.clientHeight, width: 300 });

    for (const m of opts.messages) {
      const row = document.createElement('div');
      row.setAttribute('data-message-id', m.id);
      stubRect(row, { top: m.top, height: m.height, width: 280 });
      scroller.appendChild(row);
    }
    document.body.appendChild(scroller);
    return scroller;
  }

  it('captures the topmost visible message id + Y', () => {
    const scroller = makeScroller({
      scrollTop: 500,
      scrollHeight: 3000,
      clientHeight: 400,
      messages: [
        { id: 'm80', top: 40, height: 40 }, // above viewport (scroller top=100)
        { id: 'm100', top: 120, height: 50 }, // first intersecting
        { id: 'm101', top: 180, height: 50 },
      ],
    });
    const anchor = captureVisualScrollAnchor(scroller);
    expect(anchor.messageId).toBe('m100');
    expect(anchor.messageTop).toBe(120);
    expect(anchor.scrollTop).toBe(500);
    expect(anchor.scrollHeight).toBe(3000);
    scroller.remove();
  });

  it('TASK-019: after prepend, restores the same message Y via message-id anchor', () => {
    const scroller = makeScroller({
      scrollTop: 500,
      scrollHeight: 3000,
      clientHeight: 400,
      messages: [{ id: 'm100', top: 150, height: 40 }],
    });
    const anchor = captureVisualScrollAnchor(scroller);
    expect(anchor.messageId).toBe('m100');

    // 50 older messages prepend → m100 shifts down by 800px in the viewport.
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      value: 3800,
    });
    const m100 = scroller.querySelector('[data-message-id="m100"]')!;
    stubRect(m100, { top: 950, height: 40, width: 280 });

    const delta = applyVisualScrollAnchor(scroller, anchor);
    expect(delta).toBe(800);
    expect(scroller.scrollTop).toBe(1300);
    // After compensation the message would be back at Y=150 (950 - 800).
    stubRect(m100, { top: 150, height: 40, width: 280 });
    expect(m100.getBoundingClientRect().top).toBe(anchor.messageTop);
    scroller.remove();
  });

  it('falls back to scrollHeight compensation when the message node is gone', () => {
    const scroller = makeScroller({
      scrollTop: 400,
      scrollHeight: 2000,
      clientHeight: 400,
      messages: [],
    });
    const anchor: VisualScrollAnchor = {
      messageId: 'missing',
      messageTop: 140,
      scrollTop: 400,
      scrollHeight: 2000,
    };
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      value: 2500,
    });
    const delta = applyVisualScrollAnchor(scroller, anchor);
    expect(delta).toBe(500);
    expect(scroller.scrollTop).toBe(900);
    scroller.remove();
  });

  it('TASK-021: late media growth above viewport keeps the reading message put', () => {
    // User reading m100; an image above finishes loading (+300px).
    const scroller = makeScroller({
      scrollTop: 800,
      scrollHeight: 4000,
      clientHeight: 400,
      messages: [{ id: 'm100', top: 160, height: 40 }],
    });
    const anchor = captureVisualScrollAnchor(scroller);

    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      value: 4300,
    });
    const m100 = scroller.querySelector('[data-message-id="m100"]')!;
    stubRect(m100, { top: 460, height: 40, width: 280 });

    applyVisualScrollAnchor(scroller, anchor);
    expect(scroller.scrollTop).toBe(1100);
    stubRect(m100, { top: 160, height: 40, width: 280 });
    expect(m100.getBoundingClientRect().top).toBe(160);
    scroller.remove();
  });

  it('growth below the anchored message does not move scrollTop', () => {
    const scroller = makeScroller({
      scrollTop: 800,
      scrollHeight: 4000,
      clientHeight: 400,
      messages: [{ id: 'm100', top: 160, height: 40 }],
    });
    const anchor = captureVisualScrollAnchor(scroller);
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      value: 4300,
    });
    // Anchored message Y unchanged (growth below).
    const delta = applyVisualScrollAnchor(scroller, anchor);
    expect(delta).toBe(0);
    expect(scroller.scrollTop).toBe(800);
    scroller.remove();
  });
});
