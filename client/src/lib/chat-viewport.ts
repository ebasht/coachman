/**
 * Shared chat message-list viewport metrics and scroll-policy vocabulary.
 * Position (`isAtBottom`) and follow permission (`followBottom`) are distinct —
 * do not collapse them into one mutable flag.
 */

/**
 * Slack (px) below which the list counts as stuck to the bottom.
 * Covers `.messages` bottom padding (~12px), `.messages-end` (~8px), and small
 * layout jitter without treating a short scroll-up as “still at bottom”.
 */
export const BOTTOM_THRESHOLD_PX = 48;

export type ChatViewportMeasurement = {
  /** Pixels of scrollable content below the visible area (clamped ≥ 0). */
  distanceToBottom: number;
  /** Within {@link BOTTOM_THRESHOLD_PX} of the end — factual viewport position. */
  isAtBottom: boolean;
  /** Any content remains below the viewport (even within the threshold). */
  hasMessagesBelow: boolean;
};

/**
 * Explicit programmatic scroll reason. Separate from both `isAtBottom` (fact)
 * and `followBottom` (permission to keep anchoring while content grows).
 */
export type ChatScrollIntent =
  | 'none'
  | 'initial'
  | 'jump-to-latest'
  | 'own-message'
  | 'reply-target'
  | 'history-anchor';

/** Intents that should drive the viewport to the bottom even if not there yet. */
export function isBottomTargetingIntent(intent: ChatScrollIntent): boolean {
  return (
    intent === 'initial' ||
    intent === 'jump-to-latest' ||
    intent === 'own-message'
  );
}

/** Measure scroll position of the chat messages scroller. */
export function measureChatViewport(element: HTMLElement): ChatViewportMeasurement {
  const distanceToBottom = Math.max(
    0,
    element.scrollHeight - element.scrollTop - element.clientHeight,
  );
  return {
    distanceToBottom,
    isAtBottom: distanceToBottom <= BOTTOM_THRESHOLD_PX,
    hasMessagesBelow: distanceToBottom > 0,
  };
}

/**
 * Pure outcome of a *user* scroll observation.
 * Callers must apply refs/UI from this — never initiate scroll from the handler.
 */
export type UserScrollSync = {
  isAtBottom: boolean;
  /** User gesture owns follow permission: at bottom → follow, else stop. */
  followBottom: boolean;
  /** Clear the “new messages below” affordance when the user reaches the end. */
  resetUnreadBelow: boolean;
};

/** Map a viewport measurement to user-scroll sync decisions (no scrolling). */
export function syncFromUserScroll(measurement: ChatViewportMeasurement): UserScrollSync {
  return {
    isAtBottom: measurement.isAtBottom,
    followBottom: measurement.isAtBottom,
    resetUnreadBelow: measurement.isAtBottom,
  };
}
