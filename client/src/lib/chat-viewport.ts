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
 * Scroll policy for one incoming upsert, decided from the *pre-upsert* viewport fact
 * and whether the composer is actively focused (TASK-016).
 *
 * Changing the `messages` array is never itself a scroll command — only an explicit
 * policy (or intents like `own-message` / `jump-to-latest`) may drive scroll.
 *
 * - `follow-bottom`: user was at the end and composer is idle → pin after insert
 * - `preserve`: user was reading above, OR composer is focused → leave scrollTop
 *   alone (no scrollToEnd / scrollIntoView / history-anchor). Unread + ↓ stay
 *   the reader's cue. Own-message / jump-to-latest intents are unaffected.
 */
export type IncomingScrollPolicy = 'follow-bottom' | 'preserve';

export function incomingScrollPolicy(
  wasAtBottom: boolean,
  composerFocused = false,
): IncomingScrollPolicy {
  // Typing in the composer owns the viewport — even when previously at the end.
  if (composerFocused) return 'preserve';
  return wasAtBottom ? 'follow-bottom' : 'preserve';
}

/**
 * Whether a messages-scroller ResizeObserver / late-media layout pass may pin
 * to the end. Separates textarea autoresize (viewport height change) from
 * incoming content growth.
 *
 * TASK-017: viewport-only resize (composer 1→N lines) must never pin — callers
 * only remeasure `isAtBottom` so ↓ can appear; scroll intent / follow stay put.
 * TASK-016: while composing, content growth must not yank either.
 */
export type MediaLayoutFollowInput = {
  followBottom: boolean;
  composerFocused: boolean;
  /** `scrollHeight` increased since the last observation. */
  contentGrew: boolean;
  /** `clientHeight` changed (composer autoresize, keyboard, chrome). */
  viewportResized: boolean;
};

export function shouldFollowBottomOnMediaLayout(input: MediaLayoutFollowInput): boolean {
  if (!input.followBottom) return false;
  // Viewport height change alone (composer grow/shrink) is not a scroll command.
  if (!input.contentGrew) return false;
  // While composing, content growth must not yank the feed (TASK-016).
  if (input.composerFocused) return false;
  return true;
}

/**
 * Declarative outcome of a composer/textarea autoresize (TASK-017).
 * Callers must apply only the remeasure — never scrollToEnd / never mutate
 * `followBottom` or `scrollIntent`.
 */
export type ComposerResizeSync = {
  /** Composer height change must not call scrollToEnd / scheduleFollowBottom. */
  scrollToBottom: false;
  /** User scroll intent and follow permission stay as they were. */
  mutateScrollIntent: false;
  /** Remeasure viewport so ↓ reflects post-resize `isAtBottom`. */
  remeasureIsAtBottom: true;
};

export function composerResizeSync(): ComposerResizeSync {
  return {
    scrollToBottom: false,
    mutateScrollIntent: false,
    remeasureIsAtBottom: true,
  };
}

/**
 * Declarative outcome of TASK-015 follow-bottom for one at-end incoming insert.
 * Callers must apply pin via a coalesced scroll adjustment (see {@link createRafCoalescer}).
 */
export type FollowBottomOutcome = {
  policy: 'follow-bottom';
  /** Keep anchoring while content grows. */
  followBottom: true;
  /** Arm a pin-to-end after the messages commit. */
  pinToBottom: true;
  /** ↓ FAB must stay hidden (optimistic at-bottom). */
  showScrollDown: false;
  /** `unreadBelowCount` must not increase. */
  incrementUnreadBelow: false;
};

/** Outcome bag when the pre-upsert viewport was at the end. */
export function followBottomOutcome(): FollowBottomOutcome {
  return {
    policy: 'follow-bottom',
    followBottom: true,
    pinToBottom: true,
    showScrollDown: false,
    incrementUnreadBelow: false,
  };
}

/**
 * Schedule at most one callback per animation frame.
 * A burst of follow-bottom inserts shares a single scroll adjustment instead of
 * stacking N independent smooth/trailing scroll animations.
 */
export type RafCoalescer = {
  /** Returns true when a new frame was scheduled; false when coalesced into a pending one. */
  schedule: (fn: () => void) => boolean;
  cancel: () => void;
  readonly pending: boolean;
};

export function createRafCoalescer(
  scheduleFrame: (cb: FrameRequestCallback) => number = requestAnimationFrame,
  cancelFrame: (id: number) => void = cancelAnimationFrame,
): RafCoalescer {
  let id = 0;
  return {
    schedule(fn) {
      if (id) return false;
      id = scheduleFrame(() => {
        id = 0;
        fn();
      });
      return true;
    },
    cancel() {
      if (!id) return;
      cancelFrame(id);
      id = 0;
    },
    get pending() {
      return id !== 0;
    },
  };
}
