/**
 * Touch gesture classification for chat bubbles (TASK-043).
 * One gesture resolves to at most one action — scroll, reply, or menu.
 */

export const GESTURE_MOVE_LOCK_PX = 10;
export const GESTURE_REPLY_TRIGGER_PX = 48;
export const GESTURE_HORIZONTAL_BIAS = 1.15;
export const GESTURE_LONG_PRESS_MS = 420;

export type GestureAxis = 'h' | 'v' | null;

export type GestureAction = 'none' | 'scroll' | 'reply' | 'menu';

export type GestureLockInput = {
  dx: number;
  dy: number;
  /** Movement magnitude that must be exceeded before locking an axis. */
  thresholdPx?: number;
  horizontalBias?: number;
};

/** Decide horizontal (reply) vs vertical (scroll) once movement clears the dead zone. */
export function lockGestureAxis(input: GestureLockInput): GestureAxis {
  const threshold = input.thresholdPx ?? GESTURE_MOVE_LOCK_PX;
  const bias = input.horizontalBias ?? GESTURE_HORIZONTAL_BIAS;
  const { dx, dy } = input;
  if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return null;
  return Math.abs(dx) > Math.abs(dy) * bias ? 'h' : 'v';
}

export type ResolveGestureInput = {
  axis: GestureAxis;
  /** Horizontal swipe distance (clamped ≥ 0 toward reply). */
  dx: number;
  /** True when the long-press timer fired before significant movement. */
  longPressFired: boolean;
  replyTriggerPx?: number;
};

/**
 * Resolve the single action for a completed (or held) gesture.
 * Priority: menu (hold) > reply (horizontal) > scroll (vertical) > none.
 * Hold that already fired cancels reply/scroll for the same pointer.
 */
export function resolveGestureAction(input: ResolveGestureInput): GestureAction {
  if (input.longPressFired) return 'menu';
  const trigger = input.replyTriggerPx ?? GESTURE_REPLY_TRIGGER_PX;
  if (input.axis === 'h' && input.dx >= trigger) return 'reply';
  if (input.axis === 'v') return 'scroll';
  if (input.axis === 'h') return 'none'; // horizontal but not far enough
  return 'none';
}

/** Movement large enough to cancel an in-flight long-press timer. */
export function shouldCancelLongPress(dx: number, dy: number, thresholdPx = GESTURE_MOVE_LOCK_PX): boolean {
  return Math.abs(dx) >= thresholdPx || Math.abs(dy) >= thresholdPx;
}
