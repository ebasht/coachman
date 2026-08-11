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

/**
 * Inputs for deciding whether an incoming reconcile/upsert should bump
 * `unreadBelowCount`. Counts logical inserts only — never network echoes.
 */
export type UnreadBelowIncrementInput = {
  /** True only when a new logical message was added (`inserted === true`). */
  inserted: boolean;
  /** Message belongs to the local user (own WS echo / optimistic send). */
  isOwnMessage: boolean;
  /** Factual viewport position before the insert — user was above the end. */
  isAtBottom: boolean;
};

/**
 * Whether to increment `unreadBelowCount` for one incoming operation.
 *
 * Increment only when all hold: logical insert, foreign sender, user above end.
 * Never for duplicate WS, HTTP ACK, own echo, history update of existing, or
 * update-in-place of an existing entity (`inserted === false`).
 */
export function shouldIncrementUnreadBelow(input: UnreadBelowIncrementInput): boolean {
  return input.inserted && !input.isOwnMessage && !input.isAtBottom;
}

/** Apply an unread-below counter action (logical messages, not network events). */
export function applyUnreadBelowCount(
  current: number,
  action: 'increment' | 'reset',
): number {
  if (action === 'reset') return 0;
  return current + 1;
}

/** Badge label for the ↓ FAB; large values collapse to `99+`. */
export function formatUnreadBelowBadge(count: number): string {
  if (count <= 0) return '';
  return count > 99 ? '99+' : String(count);
}

/**
 * Scroll policy for one incoming upsert, decided from the *pre-upsert* viewport fact.
 *
 * Changing the `messages` array is never itself a scroll command — only an explicit
 * policy (or intents like `own-message` / `jump-to-latest`) may drive scroll.
 *
 * - `follow-bottom`: user was at the end → pin after insert
 * - `preserve`: user was reading above → leave scrollTop alone (no scrollToEnd /
 *   scrollIntoView / history-anchor compensation). Unread + ↓ stay the reader's cue.
 */
export type IncomingScrollPolicy = 'follow-bottom' | 'preserve';

export function incomingScrollPolicy(wasAtBottom: boolean): IncomingScrollPolicy {
  return wasAtBottom ? 'follow-bottom' : 'preserve';
}
