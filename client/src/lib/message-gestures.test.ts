import { describe, expect, it } from 'vitest';
import {
  MESSAGE_GESTURE_AXIS_LOCK_PX,
  MESSAGE_GESTURE_HOLD_MS,
  MESSAGE_GESTURE_MOVE_CANCEL_PX,
  MESSAGE_GESTURE_SWIPE_TRIGGER_DX,
  applyMessageGestureEnd,
  applyMessageGestureHold,
  applyMessageGestureMove,
  createMessageGestureSession,
  isSwipeIconVisible,
  pointerCanSwipeReply,
} from './message-gestures';

function start(partial?: Partial<Parameters<typeof createMessageGestureSession>[0]>) {
  return createMessageGestureSession({
    messageId: 'm1',
    pointerId: 1,
    x: 100,
    y: 200,
    canSwipeReply: true,
    canLongPress: true,
    ...partial,
  });
}

describe('message gesture constants', () => {
  it('keeps hold timeout in the agreed band', () => {
    expect(MESSAGE_GESTURE_HOLD_MS).toBeGreaterThanOrEqual(350);
    expect(MESSAGE_GESTURE_HOLD_MS).toBeLessThanOrEqual(500);
  });

  it('keeps move-cancel threshold in the agreed band', () => {
    expect(MESSAGE_GESTURE_MOVE_CANCEL_PX).toBeGreaterThanOrEqual(8);
    expect(MESSAGE_GESTURE_MOVE_CANCEL_PX).toBeLessThanOrEqual(12);
  });
});

describe('applyMessageGestureHold (TASK-032)', () => {
  it('opens menu when still pending without movement', () => {
    const session = start();
    const result = applyMessageGestureHold(session);
    expect(result.openMenu).toBe(true);
    expect(result.session.intent).toBe('long-press');
    expect(result.session.suppressClick).toBe(true);
  });

  it('does not open menu after scroll intent won', () => {
    let session = start();
    session = applyMessageGestureMove(session, 100, 200 + MESSAGE_GESTURE_AXIS_LOCK_PX + 1).session;
    expect(session.intent).toBe('scroll');
    const hold = applyMessageGestureHold(session);
    expect(hold.openMenu).toBe(false);
  });
});

describe('vertical scroll arbitration (TASK-033)', () => {
  it('cancels long press and does not activate swipe on vertical move', () => {
    let session = start();
    const moved = applyMessageGestureMove(session, 102, 200 + MESSAGE_GESTURE_AXIS_LOCK_PX + 5);
    session = moved.session;
    expect(session.intent).toBe('scroll');
    expect(moved.cancelHold).toBe(true);
    expect(moved.swipeDx).toBeNull();
    const end = applyMessageGestureEnd(session);
    expect(end.triggerReply).toBe(false);
  });
});

describe('horizontal swipe reply (TASK-034)', () => {
  it('activates swipe and cancels long press on expressed horizontal move', () => {
    let session = start();
    const moved = applyMessageGestureMove(session, 100 + MESSAGE_GESTURE_AXIS_LOCK_PX + 8, 201);
    session = moved.session;
    expect(session.intent).toBe('swipe');
    expect(moved.cancelHold).toBe(true);
    expect(moved.swipeDx).toBeGreaterThan(0);
    expect(applyMessageGestureHold(session).openMenu).toBe(false);
  });

  it('triggers reply only past the release threshold', () => {
    let session = start();
    session = applyMessageGestureMove(session, 100 + MESSAGE_GESTURE_SWIPE_TRIGGER_DX, 200).session;
    const end = applyMessageGestureEnd(session);
    expect(end.triggerReply).toBe(true);
    expect(end.suppressClick).toBe(true);
  });

  it('does not trigger reply for short horizontal swipes', () => {
    let session = start();
    session = applyMessageGestureMove(session, 100 + 20, 200).session;
    const end = applyMessageGestureEnd(session);
    expect(end.triggerReply).toBe(false);
  });

  it('never starts reply when canSwipeReply is false', () => {
    let session = start({ canSwipeReply: false });
    const moved = applyMessageGestureMove(session, 100 + 40, 200);
    expect(moved.session.intent).not.toBe('swipe');
    expect(moved.swipeDx).toBeNull();
  });
});

describe('single intent per sequence (TASK-035)', () => {
  it('does not allow menu after swipe intent', () => {
    let session = start();
    session = applyMessageGestureMove(session, 140, 200).session;
    expect(session.intent).toBe('swipe');
    expect(applyMessageGestureHold(session).openMenu).toBe(false);
  });

  it('does not allow reply after long-press intent', () => {
    let session = start();
    session = applyMessageGestureHold(session).session;
    session = applyMessageGestureMove(session, 160, 200).session;
    const end = applyMessageGestureEnd(session);
    expect(end.triggerReply).toBe(false);
  });

  it('does not allow reply after scroll intent', () => {
    let session = start();
    session = applyMessageGestureMove(session, 100, 240).session;
    expect(session.intent).toBe('scroll');
    // Further horizontal noise must not flip to swipe.
    session = applyMessageGestureMove(session, 180, 250).session;
    expect(session.intent).toBe('scroll');
    expect(applyMessageGestureEnd(session).triggerReply).toBe(false);
  });
});

describe('helpers', () => {
  it('shows swipe icon past the visibility threshold', () => {
    expect(isSwipeIconVisible(10)).toBe(false);
    expect(isSwipeIconVisible(21)).toBe(true);
  });

  it('allows swipe only for touch/pen pointers', () => {
    expect(pointerCanSwipeReply('touch')).toBe(true);
    expect(pointerCanSwipeReply('pen')).toBe(true);
    expect(pointerCanSwipeReply('mouse')).toBe(false);
  });
});
