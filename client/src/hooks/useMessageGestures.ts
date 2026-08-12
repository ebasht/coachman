import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  MESSAGE_GESTURE_HOLD_MS,
  applyMessageGestureEnd,
  applyMessageGestureHold,
  applyMessageGestureMove,
  createMessageGestureSession,
  isSwipeIconVisible,
  pointerCanSwipeReply,
  type MessageGestureSession,
} from '../lib/message-gestures';

export type MessageGestureBindOptions = {
  messageId: string;
  canSwipeReply: boolean;
  canLongPress: boolean;
};

export type UseMessageGesturesOptions = {
  onLongPress: (messageId: string, anchorEl: HTMLElement) => void;
  onSwipeReply: (messageId: string) => void;
};

/**
 * Gesture controller for chat message rows (TASK-031–035).
 * Recognizes scroll vs swipe-reply vs long-press; business actions stay in the caller.
 */
export function useMessageGestures(options: UseMessageGesturesOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const sessionRef = useRef<MessageGestureSession | null>(null);
  const holdTimerRef = useRef<number | undefined>(undefined);
  /** Stable bubble anchors — survives re-renders mid-hold (unlike a render-local let). */
  const bubbleElsRef = useRef(new Map<string, HTMLElement>());
  const suppressClickRef = useRef(false);

  const [swipeDx, setSwipeDx] = useState<{ id: string; dx: number } | null>(null);

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current !== undefined) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = undefined;
    }
  }, []);

  const clearSuppressSoon = useCallback(() => {
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 50);
  }, []);

  const armHoldTimer = useCallback((messageId: string) => {
    clearHoldTimer();
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = undefined;
      const session = sessionRef.current;
      if (!session || session.messageId !== messageId) return;
      const result = applyMessageGestureHold(session);
      sessionRef.current = result.session;
      if (!result.openMenu) return;
      suppressClickRef.current = true;
      const anchor = bubbleElsRef.current.get(messageId) ?? null;
      if (!anchor) {
        // Keep suppress so the trailing click does not do something else.
        clearSuppressSoon();
        return;
      }
      // Clear native text selection before the custom menu mounts (iOS Safari).
      try {
        window.getSelection()?.removeAllRanges();
      } catch {
        /* ignore */
      }
      try {
        navigator.vibrate?.(10);
      } catch {
        /* ignore */
      }
      optionsRef.current.onLongPress(messageId, anchor);
      clearSuppressSoon();
    }, MESSAGE_GESTURE_HOLD_MS);
  }, [clearHoldTimer, clearSuppressSoon]);

  const consumeSuppressClick = useCallback(() => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  }, []);

  const resetGestures = useCallback(() => {
    clearHoldTimer();
    sessionRef.current = null;
    suppressClickRef.current = false;
    setSwipeDx(null);
  }, [clearHoldTimer]);

  const setBubbleEl = useCallback((messageId: string, el: HTMLElement | null) => {
    if (el) bubbleElsRef.current.set(messageId, el);
    else bubbleElsRef.current.delete(messageId);
  }, []);

  const bindMessageGestures = useCallback(
    (bind: MessageGestureBindOptions) => {
      const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
        if (e.button != null && e.button !== 0) return;
        // Ignore secondary interactions starting on interactive children
        // (links, media open, more-button) — they own their own clicks.
        const target = e.target as HTMLElement | null;
        if (target?.closest('a, button, input, textarea, [data-no-message-gesture]')) {
          return;
        }

        const canSwipe = bind.canSwipeReply && pointerCanSwipeReply(e.pointerType);
        sessionRef.current = createMessageGestureSession({
          messageId: bind.messageId,
          pointerId: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          canSwipeReply: canSwipe,
          canLongPress: bind.canLongPress,
        });
        setSwipeDx(null);
        if (bind.canLongPress) {
          armHoldTimer(bind.messageId);
        }
        // Capture so move/up still arrive if the pointer leaves the row.
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      };

      const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
        const session = sessionRef.current;
        if (!session || session.pointerId !== e.pointerId) return;
        if (session.messageId !== bind.messageId) return;

        const result = applyMessageGestureMove(session, e.clientX, e.clientY);
        sessionRef.current = result.session;
        if (result.cancelHold) clearHoldTimer();
        if (result.session.suppressClick) suppressClickRef.current = true;

        if (result.swipeDx != null) {
          setSwipeDx({ id: bind.messageId, dx: result.swipeDx });
        } else if (result.session.intent === 'scroll' || result.session.intent === 'done') {
          setSwipeDx((cur) => (cur?.id === bind.messageId ? null : cur));
        }
      };

      const finish = (e: ReactPointerEvent<HTMLElement>) => {
        const session = sessionRef.current;
        if (!session || session.pointerId !== e.pointerId) return;
        if (session.messageId !== bind.messageId) return;
        clearHoldTimer();
        const end = applyMessageGestureEnd(session);
        sessionRef.current = null;
        if (end.clearSwipe) setSwipeDx(null);
        if (end.suppressClick) suppressClickRef.current = true;
        if (end.triggerReply) {
          optionsRef.current.onSwipeReply(bind.messageId);
        }
        if (end.suppressClick) clearSuppressSoon();
      };

      const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
        finish(e);
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      };

      const onPointerCancel = (e: ReactPointerEvent<HTMLElement>) => {
        const session = sessionRef.current;
        if (!session || session.pointerId !== e.pointerId) return;
        if (session.messageId !== bind.messageId) return;
        clearHoldTimer();
        sessionRef.current = null;
        setSwipeDx((cur) => (cur?.id === bind.messageId ? null : cur));
        if (suppressClickRef.current) clearSuppressSoon();
      };

      return {
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel,
      };
    },
    [armHoldTimer, clearHoldTimer, clearSuppressSoon],
  );

  return {
    swipeDx,
    isSwipeIconVisible: (id: string) =>
      !!(swipeDx && swipeDx.id === id && isSwipeIconVisible(swipeDx.dx)),
    rowSwipeStyle: (id: string): { transform: string } | undefined =>
      swipeDx?.id === id ? { transform: `translateX(${swipeDx.dx}px)` } : undefined,
    bindMessageGestures,
    setBubbleEl,
    consumeSuppressClick,
    resetGestures,
  };
}
