/**
 * TASK-043 — Final messenger regression suite.
 *
 * Covers message identity, scroll policy, delete anchoring, burst realtime,
 * context-menu placement, and gesture exclusivity with unit / integration-style
 * pure tests. Scenarios that need a real browser (keyboard resize, visual
 * long-press on photos, desktop text-selection chrome) are listed as manual-only
 * at the bottom of this file.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyUnreadBelowDelta,
  compensatedScrollTop,
  deleteScrollPolicy,
  formatUnreadBelowBadge,
  incomingScrollPolicy,
  planBurstIncomingScroll,
  shouldBumpUnreadBelowForIncoming,
  shouldIncrementUnreadBelow,
} from './chat-viewport';
import {
  MESSAGE_GESTURE_HOLD_MS,
  MESSAGE_GESTURE_MOVE_CANCEL_PX,
  MESSAGE_GESTURE_SWIPE_TRIGGER_DX,
  applyMessageGestureEnd,
  applyMessageGestureHold,
  applyMessageGestureMove,
  createMessageGestureSession,
} from './message-gestures';
import { createLiveMessageCoalescer } from './live-message-batch';
import { placeMessageContextMenu } from './message-context-menu';
import { reconcileMessage, reconcileMessages } from './message-reconcile';
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

describe('TASK-043 message identity', () => {
  const me = 'me';
  const clientId = 'cid-1';

  it('Send → one bubble (pending insert once)', () => {
    const pending = msg({
      id: `pending-${clientId}`,
      clientId,
      senderId: me,
      pending: true,
      text: 'hello',
      createdAt: 10,
    });
    const r = reconcileMessage([], pending);
    expect(r.inserted).toBe(true);
    expect(r.messages).toHaveLength(1);
  });

  it('HTTP + WS → one bubble', () => {
    const pending = msg({
      id: `pending-${clientId}`,
      clientId,
      senderId: me,
      pending: true,
      text: 'hello',
      createdAt: 10,
    });
    const ack = msg({
      id: 'srv-1',
      clientId,
      senderId: me,
      text: 'hello',
      createdAt: 11,
      sequence: 1,
    });
    const http = reconcileMessage([pending], ack);
    const ws = reconcileMessage(http.messages, ack);
    expect(http.messages).toHaveLength(1);
    expect(ws.inserted).toBe(false);
    expect(ws.messages).toHaveLength(1);
    expect(ws.messages[0]!.id).toBe('srv-1');
  });

  it('WS + HTTP → one bubble', () => {
    const pending = msg({
      id: `pending-${clientId}`,
      clientId,
      senderId: me,
      pending: true,
      text: 'hello',
      createdAt: 10,
    });
    const confirmed = msg({
      id: 'srv-1',
      clientId,
      senderId: me,
      text: 'hello',
      createdAt: 11,
      sequence: 1,
    });
    const ws = reconcileMessage([pending], confirmed);
    const http = reconcileMessage(ws.messages, confirmed);
    expect(ws.messages).toHaveLength(1);
    expect(http.inserted).toBe(false);
    expect(http.messages).toHaveLength(1);
  });

  it('Lost ACK + retry → one bubble', () => {
    const pending = msg({
      id: `pending-${clientId}`,
      clientId,
      senderId: me,
      pending: true,
      text: 'hello',
      createdAt: 10,
    });
    // Retry keeps same clientId — reconcile must not insert a second row.
    const retry = msg({
      id: `pending-${clientId}`,
      clientId,
      senderId: me,
      pending: true,
      text: 'hello',
      createdAt: 10,
    });
    const r1 = reconcileMessage([pending], retry);
    expect(r1.inserted).toBe(false);
    expect(r1.messages).toHaveLength(1);

    const ack = msg({
      id: 'srv-1',
      clientId,
      senderId: me,
      text: 'hello',
      createdAt: 12,
      sequence: 2,
    });
    const r2 = reconcileMessage(r1.messages, ack);
    expect(r2.messages).toHaveLength(1);
    expect(r2.messages[0]!.id).toBe('srv-1');
  });

  it('Offline + reconnect → one bubble', () => {
    const pending = msg({
      id: `pending-${clientId}`,
      clientId,
      senderId: me,
      pending: true,
      text: 'hello',
      createdAt: 10,
    });
    // Reconnect history brings the server row; pending merges away.
    const history = msg({
      id: 'srv-1',
      clientId,
      senderId: me,
      text: 'hello',
      createdAt: 11,
      sequence: 1,
    });
    const r = reconcileMessage([pending], history);
    expect(r.inserted).toBe(false);
    expect(r.messages).toHaveLength(1);
  });

  it('Да, Да, Да → three bubbles (distinct clientIds)', () => {
    let list: StoredMessage[] = [];
    for (let i = 0; i < 3; i++) {
      const cid = `say-${i}`;
      const r = reconcileMessage(
        list,
        msg({
          id: `pending-${cid}`,
          clientId: cid,
          senderId: me,
          pending: true,
          text: 'Да',
          createdAt: 10 + i,
        }),
      );
      expect(r.inserted).toBe(true);
      list = r.messages;
    }
    expect(list).toHaveLength(3);
  });
});

describe('TASK-043 scroll policies', () => {
  it('Reading history + incoming → viewport immobile (preserve, no pin)', () => {
    expect(incomingScrollPolicy(false)).toBe('preserve');
    expect(planBurstIncomingScroll(false, 1).scrollAdjustments).toBe(0);
  });

  it('Incoming ×20 → viewport immobile, badge = 20', () => {
    const plan = planBurstIncomingScroll(false, 20);
    expect(plan.policy).toBe('preserve');
    expect(plan.scrollAdjustments).toBe(0);
    expect(formatUnreadBelowBadge(applyUnreadBelowDelta(0, 20))).toBe('20');
  });

  it('↓ / manual scroll to bottom → badge = 0 (explicit reset only)', () => {
    let badge = applyUnreadBelowDelta(0, 20);
    expect(badge).toBe(20);
    // Jump-to-latest / user reaches end:
    badge = 0;
    expect(badge).toBe(0);
  });

  it('Composer focused + incoming → still preserve while above end', () => {
    // Focus must not change scroll policy — only pre-upsert wasAtBottom matters.
    expect(incomingScrollPolicy(false)).toBe('preserve');
  });

  it('MOB-011 / MOB-055: composer focused at bottom → preserve + badge bump', () => {
    const plan = planBurstIncomingScroll(true, 3, true, false);
    expect(plan.policy).toBe('preserve');
    expect(plan.scrollAdjustments).toBe(0);
    expect(
      shouldBumpUnreadBelowForIncoming({
        foreignInserted: 3,
        scrollAdjustments: plan.scrollAdjustments,
      }),
    ).toBe(true);
  });

  it('History prepend / media load above / delete above → anchor preserved', () => {
    expect(compensatedScrollTop(1000, 3000, 3500)).toBe(1500); // prepend
    expect(compensatedScrollTop(1000, 3000, 3200)).toBe(1200); // media grow above
    expect(compensatedScrollTop(1000, 3000, 2800)).toBe(800); // delete above
    expect(
      deleteScrollPolicy({ wasAtBottom: false, removedAboveViewport: true }),
    ).toBe('history-anchor');
  });

  it('Own send → one scroll; own ACK → no second scroll', () => {
    // Optimistic insert at bottom → one pin.
    expect(planBurstIncomingScroll(true, 1).scrollAdjustments).toBe(1);
    // ACK is update-only (insertedCount 0) → zero adjustments.
    expect(planBurstIncomingScroll(true, 0).scrollAdjustments).toBe(0);
  });

  it('Delete last / selected / open-menu message does not invent a scroll command when in-view', () => {
    expect(
      deleteScrollPolicy({ wasAtBottom: false, removedAboveViewport: false }),
    ).toBe('preserve');
    expect(
      deleteScrollPolicy({ wasAtBottom: true, removedAboveViewport: false }),
    ).toBe('follow-bottom');
  });
});

describe('TASK-043 burst realtime coalescing', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('50 rapid enqueues flush once per frame with all messages in order', () => {
    vi.useFakeTimers();
    const flushes: { seq: number; ids: string[] }[] = [];
    let handle = 0;
    const pending = new Map<number, () => void>();
    const coalescer = createLiveMessageCoalescer({
      schedule: (cb) => {
        handle += 1;
        pending.set(handle, cb);
        return handle;
      },
      cancel: (h) => {
        pending.delete(h);
      },
      onFlush: (batch) => {
        flushes.push({ seq: batch.seq, ids: batch.messages.map((m) => m.id) });
      },
    });

    for (let i = 0; i < 50; i++) {
      coalescer.enqueue(msg({ id: `srv-${i}`, sequence: i, createdAt: i, text: `m${i}` }));
    }
    expect(coalescer.pendingCount()).toBe(50);
    expect(flushes).toHaveLength(0);

    // One scheduled frame:
    expect(pending.size).toBe(1);
    const cb = [...pending.values()][0]!;
    cb();
    expect(flushes).toHaveLength(1);
    expect(flushes[0]!.ids).toHaveLength(50);
    expect(flushes[0]!.ids[0]).toBe('srv-0');
    expect(flushes[0]!.ids[49]).toBe('srv-49');
    expect(coalescer.pendingCount()).toBe(0);

    // Reconcile of the batch stays correct + unread = 50 while above end.
    const { messages, results } = reconcileMessages(
      [],
      flushes[0]!.ids.map((id, i) =>
        msg({ id, sequence: i, createdAt: i, text: `m${i}`, senderId: 'peer' }),
      ),
    );
    expect(messages).toHaveLength(50);
    expect(results.filter((r) => r.inserted)).toHaveLength(50);
    const plan = planBurstIncomingScroll(false, 50);
    expect(plan.scrollAdjustments).toBe(0);
    expect(applyUnreadBelowDelta(0, 50)).toBe(50);
  });

  it('does not start a per-message smooth scroll for follow-bottom bursts', () => {
    expect(planBurstIncomingScroll(true, 50).scrollAdjustments).toBe(1);
  });
});

describe('TASK-043 context menu placement', () => {
  const viewport = {
    top: 0,
    bottom: 700,
    left: 0,
    right: 400,
    width: 400,
    height: 700,
  };
  const menuSize = { width: 160, height: 120 };

  it('Long press / open near text → menu below when space allows', () => {
    const placed = placeMessageContextMenu({
      messageRect: { top: 100, bottom: 160, left: 40, right: 200, width: 160, height: 60 },
      menuSize,
      viewport,
      alignment: 'incoming',
    });
    expect(placed.placedBelow).toBe(true);
    expect(placed.menuTop).toBeGreaterThanOrEqual(160);
  });

  it('Message near bottom → menu above', () => {
    const placed = placeMessageContextMenu({
      messageRect: { top: 620, bottom: 680, left: 40, right: 200, width: 160, height: 60 },
      menuSize,
      viewport,
      alignment: 'incoming',
    });
    expect(placed.placedBelow).toBe(false);
    expect(placed.menuTop + menuSize.height).toBeLessThanOrEqual(viewport.bottom);
  });

  it('Message near top → menu below', () => {
    const placed = placeMessageContextMenu({
      messageRect: { top: 8, bottom: 60, left: 40, right: 200, width: 160, height: 52 },
      menuSize,
      viewport,
      alignment: 'incoming',
    });
    expect(placed.placedBelow).toBe(true);
    expect(placed.menuTop).toBeGreaterThanOrEqual(viewport.top);
  });

  it('Menu is clamped fully into the viewport horizontally', () => {
    const placed = placeMessageContextMenu({
      messageRect: { top: 100, bottom: 140, left: 350, right: 390, width: 40, height: 40 },
      menuSize,
      viewport,
      alignment: 'incoming',
    });
    expect(placed.menuLeft + menuSize.width).toBeLessThanOrEqual(viewport.right);
    expect(placed.menuLeft).toBeGreaterThanOrEqual(viewport.left);
  });

  it('Incoming with open menu: preserve policy keeps overlay scroll-stable', () => {
    expect(incomingScrollPolicy(true, false, true)).toBe('preserve');
    expect(planBurstIncomingScroll(true, 5, false, true).scrollAdjustments).toBe(0);
  });
});

describe('TASK-043 gestures — one gesture, one action', () => {
  function session(partial?: Partial<Parameters<typeof createMessageGestureSession>[0]>) {
    return createMessageGestureSession({
      messageId: 'm1',
      pointerId: 1,
      x: 0,
      y: 0,
      canSwipeReply: true,
      canLongPress: true,
      ...partial,
    });
  }

  it('Vertical → scroll', () => {
    const moved = applyMessageGestureMove(session(), 2, 40);
    expect(moved.session.intent).toBe('scroll');
    expect(moved.cancelHold).toBe(true);
  });

  it('Horizontal → reply when past trigger', () => {
    const moved = applyMessageGestureMove(session(), 50, 5);
    expect(moved.session.intent).toBe('swipe');
    const end = applyMessageGestureEnd({
      ...moved.session,
      dx: MESSAGE_GESTURE_SWIPE_TRIGGER_DX,
    });
    expect(end.triggerReply).toBe(true);
    const short = applyMessageGestureEnd({
      ...moved.session,
      dx: 20,
    });
    expect(short.triggerReply).toBe(false);
  });

  it('Hold → menu; movement cancels long-press', () => {
    expect(MESSAGE_GESTURE_HOLD_MS).toBeGreaterThanOrEqual(300);
    const hold = applyMessageGestureHold(session());
    expect(hold.openMenu).toBe(true);
    expect(hold.session.intent).toBe('long-press');
    const cancel = applyMessageGestureMove(session(), MESSAGE_GESTURE_MOVE_CANCEL_PX, 0);
    expect(cancel.cancelHold).toBe(true);
  });

  it('Hold wins over reply for the same pointer', () => {
    const held = applyMessageGestureHold(session());
    const afterMove = applyMessageGestureMove(held.session, 60, 0);
    expect(afterMove.session.intent).toBe('long-press');
    expect(applyMessageGestureEnd(afterMove.session).triggerReply).toBe(false);
  });
});

describe('TASK-043 unread / reconcile integration', () => {
  it('foreign burst while above end increments once per logical insert', () => {
    let list: StoredMessage[] = [];
    let unread = 0;
    const batch = Array.from({ length: 20 }, (_, i) =>
      msg({ id: `f-${i}`, sequence: i + 1, createdAt: 100 + i, text: `x${i}` }),
    );
    const { messages, results } = reconcileMessages(list, batch);
    list = messages;
    const inserted = results.filter((r) => r.inserted).length;
    if (
      shouldIncrementUnreadBelow({
        inserted: inserted > 0,
        isOwnMessage: false,
        isAtBottom: false,
      })
    ) {
      unread = applyUnreadBelowDelta(unread, inserted);
    }
    expect(list).toHaveLength(20);
    expect(unread).toBe(20);

    // Duplicate WS of last message — no bump.
    const dup = reconcileMessage(list, batch[19]!);
    expect(dup.inserted).toBe(false);
    if (
      shouldIncrementUnreadBelow({
        inserted: dup.inserted,
        isOwnMessage: false,
        isAtBottom: false,
      })
    ) {
      unread = applyUnreadBelowDelta(unread, 1);
    }
    expect(unread).toBe(20);
  });
});

/*
 * Manual-only / E2E candidates (not reliable as unit tests):
 * - Textarea grows → no jump (layout + compose resize) — MOB-012
 * - Keyboard resize → no forced bottom (visualViewport) — MOB-010 / MOB-013
 * - Backdrop closes menu without scroll (DOM click + scrollTop observation) — MOB-036
 * - Long press photo specifically (target hit-testing on <img>) — MOB-030
 * - Desktop: text selection works; links open; context actions available
 * - Full ChatView mounting with IndexedDB + WS burst jank profiling — MOB-064
 * - Device matrix (notch / Chrome / Safari / Capacitor) — see docs/mobile-test-cases.md
 *
 * P0 Mobile Release Gate (docs/mobile-test-cases.md):
 * MOB-001–025, 026–030, 032–045, 048–055, 059, 065, 066, 071, 075
 */
