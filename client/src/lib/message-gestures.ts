/**
 * Pure message gesture recognition (TASK-031–035).
 * Distinguishes vertical scroll, horizontal swipe-to-reply, and long-press.
 * Emits intent only — callers own business actions (menu / reply).
 */

/** Hold duration before long-press activates (ms). */
export const MESSAGE_GESTURE_HOLD_MS = 420;

/** Movement (px) that cancels a pending long-press before axis lock. */
export const MESSAGE_GESTURE_MOVE_CANCEL_PX = 10;

/** Distance (px) before locking to a horizontal or vertical axis. */
export const MESSAGE_GESTURE_AXIS_LOCK_PX = 10;

/** Horizontal wins axis lock when |dx| > |dy| * ratio. */
export const MESSAGE_GESTURE_AXIS_RATIO = 1.15;

/** Max visual translate for swipe-to-reply (px). */
export const MESSAGE_GESTURE_SWIPE_MAX_DX = 72;

/** Release past this dx triggers reply (px). */
export const MESSAGE_GESTURE_SWIPE_TRIGGER_DX = 48;

/** Show the reply icon once swipe exceeds this (px). */
export const MESSAGE_GESTURE_SWIPE_ICON_DX = 20;

/**
 * Mutually exclusive gesture intents for one pointer sequence.
 * After a non-`pending` intent is chosen, other candidates are cancelled.
 */
export type MessageGestureIntent =
  | 'pending'
  | 'scroll'
  | 'swipe'
  | 'long-press'
  | 'done';

export type MessageGestureAxis = 'h' | 'v' | null;

export type MessageGestureSession = {
  messageId: string;
  pointerId: number;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  axis: MessageGestureAxis;
  intent: MessageGestureIntent;
  canSwipeReply: boolean;
  canLongPress: boolean;
  /** True after any consuming intent so click/open must not fire. */
  suppressClick: boolean;
};

export type MessageGestureStartInput = {
  messageId: string;
  pointerId: number;
  x: number;
  y: number;
  canSwipeReply: boolean;
  canLongPress: boolean;
};

export type MessageGestureMoveResult = {
  session: MessageGestureSession;
  /** Clear the armed long-press timer. */
  cancelHold: boolean;
  /** Visual swipe offset for this message (0 clears). */
  swipeDx: number | null;
};

export type MessageGestureHoldResult = {
  session: MessageGestureSession;
  /** Fire long-press menu when true. */
  openMenu: boolean;
};

export type MessageGestureEndResult = {
  session: MessageGestureSession | null;
  triggerReply: boolean;
  suppressClick: boolean;
  clearSwipe: boolean;
};

export function createMessageGestureSession(
  input: MessageGestureStartInput,
): MessageGestureSession {
  return {
    messageId: input.messageId,
    pointerId: input.pointerId,
    startX: input.x,
    startY: input.y,
    dx: 0,
    dy: 0,
    axis: null,
    intent: 'pending',
    canSwipeReply: input.canSwipeReply,
    canLongPress: input.canLongPress,
    suppressClick: false,
  };
}

/**
 * Apply a move sample. Once intent is scroll / swipe / long-press / done,
 * competing candidates stay cancelled for the rest of the sequence.
 */
export function applyMessageGestureMove(
  session: MessageGestureSession,
  x: number,
  y: number,
): MessageGestureMoveResult {
  const next: MessageGestureSession = {
    ...session,
    dx: x - session.startX,
    dy: y - session.startY,
  };

  if (next.intent === 'long-press' || next.intent === 'done') {
    return { session: next, cancelHold: true, swipeDx: null };
  }

  if (next.intent === 'scroll') {
    return { session: next, cancelHold: true, swipeDx: null };
  }

  if (next.intent === 'swipe') {
    if (!next.canSwipeReply) {
      return { session: { ...next, intent: 'done' }, cancelHold: true, swipeDx: null };
    }
    const clamped = clampSwipeDx(next.dx);
    next.dx = clamped;
    next.suppressClick = clamped > MESSAGE_GESTURE_MOVE_CANCEL_PX || next.suppressClick;
    return {
      session: next,
      cancelHold: true,
      swipeDx: clamped,
    };
  }

  // pending
  const absX = Math.abs(next.dx);
  const absY = Math.abs(next.dy);
  if (absX < MESSAGE_GESTURE_AXIS_LOCK_PX && absY < MESSAGE_GESTURE_AXIS_LOCK_PX) {
    // Small jitter — keep waiting for hold, but cancel hold past cancel threshold.
    if (absX >= MESSAGE_GESTURE_MOVE_CANCEL_PX || absY >= MESSAGE_GESTURE_MOVE_CANCEL_PX) {
      next.intent = absY >= absX ? 'scroll' : next.canSwipeReply ? 'pending' : 'done';
      if (next.intent !== 'pending') {
        next.suppressClick = true;
        return { session: next, cancelHold: true, swipeDx: null };
      }
    }
    return { session: next, cancelHold: false, swipeDx: null };
  }

  // Axis lock
  const horizontal = absX > absY * MESSAGE_GESTURE_AXIS_RATIO;
  if (horizontal && next.canSwipeReply) {
    next.axis = 'h';
    next.intent = 'swipe';
    const clamped = clampSwipeDx(next.dx);
    next.dx = clamped;
    next.suppressClick = true;
    return { session: next, cancelHold: true, swipeDx: clamped };
  }

  // Vertical (or horizontal without swipe permission) → native scroll; no reply.
  next.axis = horizontal ? 'h' : 'v';
  next.intent = 'scroll';
  next.suppressClick = true;
  return { session: next, cancelHold: true, swipeDx: null };
}

/** Long-press timer fired — only valid while still pending with no movement intent. */
export function applyMessageGestureHold(
  session: MessageGestureSession,
): MessageGestureHoldResult {
  if (session.intent !== 'pending' || !session.canLongPress) {
    return { session, openMenu: false };
  }
  const next: MessageGestureSession = {
    ...session,
    intent: 'long-press',
    suppressClick: true,
  };
  return { session: next, openMenu: true };
}

export function applyMessageGestureEnd(
  session: MessageGestureSession | null,
): MessageGestureEndResult {
  if (!session) {
    return {
      session: null,
      triggerReply: false,
      suppressClick: false,
      clearSwipe: false,
    };
  }

  const triggerReply =
    session.intent === 'swipe' &&
    session.canSwipeReply &&
    session.dx >= MESSAGE_GESTURE_SWIPE_TRIGGER_DX;

  return {
    session: { ...session, intent: 'done' },
    triggerReply,
    suppressClick: session.suppressClick || triggerReply,
    clearSwipe: session.intent === 'swipe' || session.dx > 0,
  };
}

export function clampSwipeDx(dx: number): number {
  return Math.max(0, Math.min(MESSAGE_GESTURE_SWIPE_MAX_DX, dx));
}

export function isSwipeIconVisible(dx: number): boolean {
  return dx > MESSAGE_GESTURE_SWIPE_ICON_DX;
}

/**
 * Whether a pointer type participates in swipe-to-reply.
 * Mouse drags stay for selection / click affordances (TASK-039).
 */
export function pointerCanSwipeReply(pointerType: string): boolean {
  return pointerType === 'touch' || pointerType === 'pen';
}
