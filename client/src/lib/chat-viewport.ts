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

/**
 * TASK-022 — Own Send has exactly one scroll intent source: the user Send action.
 *
 * Network / storage follow-ups for the same own bubble must not re-arm pin-to-bottom:
 * HTTP ACK, WebSocket echo, persistence refresh, status ticks.
 */
export type OwnMessageScrollSource =
  | 'user-send'
  | 'http-ack'
  | 'ws-echo'
  | 'persistence'
  | 'status';

/** True only for the optimistic user Send path (`scrollIntent: 'own-message'`). */
export function shouldArmOwnMessageScroll(source: OwnMessageScrollSource): boolean {
  return source === 'user-send';
}

/**
 * Whether a WebSocket reconcile for `senderId === me` may arm follow-bottom.
 * Own echoes / ACK merges are not scroll commands (TASK-022).
 */
export function shouldFollowBottomForIncomingOwnMessage(): boolean {
  return false;
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
 * and whether the composer is actively focused (TASK-016) or a message context menu
 * is open (TASK-040).
 *
 * Changing the `messages` array is never itself a scroll command — only an explicit
 * policy (or intents like `own-message` / `jump-to-latest`) may drive scroll.
 *
 * - `follow-bottom`: user was at the end and composer is idle → pin after insert
 * - `preserve`: user was reading above, OR composer is focused, OR context menu is
 *   open → leave scrollTop alone (no scrollToEnd / scrollIntoView / history-anchor).
 *   Unread + ↓ stay the reader's cue. Own-message / jump-to-latest intents are
 *   unaffected when the menu is closed.
 */
export type IncomingScrollPolicy = 'follow-bottom' | 'preserve';

export function incomingScrollPolicy(
  wasAtBottom: boolean,
  composerFocused = false,
  contextMenuOpen = false,
): IncomingScrollPolicy {
  // Typing / open message menu owns the viewport — even when previously at the end.
  if (composerFocused || contextMenuOpen) return 'preserve';
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
 * TASK-018: soft-keyboard / visualViewport shell open↔close is never permission
 * to pin — even when content and viewport change in the same frame.
 */
export type MediaLayoutFollowInput = {
  followBottom: boolean;
  composerFocused: boolean;
  /** `scrollHeight` increased since the last observation. */
  contentGrew: boolean;
  /** `clientHeight` changed (composer autoresize, keyboard, chrome). */
  viewportResized: boolean;
  /**
   * Soft keyboard / visualViewport shell is open or settling after close
   * (TASK-018). Never treat as scrollToBottom permission.
   */
  keyboardShellActive?: boolean;
  /**
   * Factual at-bottom *before* this layout/media size change (TASK-020).
   * ResizeObserver must not pin merely because `followBottom` is still armed —
   * only when the user was actually at the end.
   */
  wasAtBottom?: boolean;
  /**
   * Anchored message context menu is open (TASK-040).
   * Incoming / late media must not move scrollTop under a stable overlay.
   */
  contextMenuOpen?: boolean;
};

export function shouldFollowBottomOnMediaLayout(input: MediaLayoutFollowInput): boolean {
  if (!input.followBottom) return false;
  // visualViewport.resize / IME open-close must not authorize a bottom pin.
  if (input.keyboardShellActive) return false;
  // Viewport height change alone (composer grow/shrink) is not a scroll command.
  if (!input.contentGrew) return false;
  // While composing, content growth must not yank the feed (TASK-016).
  if (input.composerFocused) return false;
  // Open message menu freezes the list under the anchored overlay (TASK-040).
  if (input.contextMenuOpen) return false;
  // TASK-020: any resize/media pass is not an unconditional scrollToBottom.
  // Pin only when the pre-change viewport was at the end (follow alone is insufficient).
  if (input.wasAtBottom === false) return false;
  return true;
}

/** Selector for message rows that can act as visual scroll anchors. */
export const MESSAGE_ANCHOR_SELECTOR = '[data-message-id]';

/** Escape a message id for use inside an attribute selector. */
export function escapeMessageIdForSelector(messageId: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(messageId);
  }
  // jsdom / older runtimes may lack CSS.escape — ids are opaque server tokens.
  return messageId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function messageAnchorSelector(messageId: string): string {
  return `[data-message-id="${escapeMessageIdForSelector(messageId)}"]`;
}

/**
 * Snapshot used to keep a message at a stable Y after prepend / late layout.
 * Prefer `messageId` + `messageTop` (`getBoundingClientRect().top`); keep
 * scrollHeight fields as a reliable fallback for pure prepends (TASK-019).
 */
export type VisualScrollAnchor = {
  messageId: string | null;
  /** Viewport Y of the anchored message at capture time. */
  messageTop: number | null;
  scrollTop: number;
  scrollHeight: number;
};

/**
 * Capture a visual anchor for the current viewport.
 * Prefers the topmost message row that intersects the scroller (TASK-019).
 */
export function captureVisualScrollAnchor(scroller: HTMLElement): VisualScrollAnchor {
  const scrollerRect = scroller.getBoundingClientRect();
  const scrollerTop = scrollerRect.top;
  const scrollerBottom = scrollerTop + scroller.clientHeight;
  const nodes = scroller.querySelectorAll(MESSAGE_ANCHOR_SELECTOR);

  let messageId: string | null = null;
  let messageTop: number | null = null;

  for (const node of nodes) {
    const id = node.getAttribute('data-message-id');
    if (!id) continue;
    const rect = node.getBoundingClientRect();
    // First intersecting row in DOM order ≈ topmost visible message.
    if (rect.bottom > scrollerTop && rect.top < scrollerBottom) {
      messageId = id;
      messageTop = rect.top;
      break;
    }
  }

  return {
    messageId,
    messageTop,
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
  };
}

/**
 * Restore scroll so the anchored message keeps its previous Y position.
 * Falls back to `scrollTop + ΔscrollHeight` when the message node is gone.
 * Returns the delta applied to `scrollTop`.
 */
export function applyVisualScrollAnchor(
  scroller: HTMLElement,
  anchor: VisualScrollAnchor,
): number {
  if (anchor.messageId != null && anchor.messageTop != null) {
    const el = scroller.querySelector(
      messageAnchorSelector(anchor.messageId),
    ) as HTMLElement | null;
    if (el) {
      const delta = el.getBoundingClientRect().top - anchor.messageTop;
      if (delta !== 0) {
        scroller.scrollTop += delta;
      }
      return delta;
    }
  }

  const delta = scroller.scrollHeight - anchor.scrollHeight;
  if (delta !== 0) {
    scroller.scrollTop = anchor.scrollTop + delta;
  }
  return delta;
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
 * Declarative outcome of a visualViewport / soft-keyboard shell resize (TASK-018).
 *
 * `visualViewport.resize` may drive available height and floating UI position,
 * but must never be treated as permission to `scrollToBottom()`. Callers leave
 * logical `scrollTop` alone (or restore a pre-keyboard lock) and only remeasure.
 */
export type VisualViewportResizeSync = {
  scrollToBottom: false;
  mutateScrollIntent: false;
  mutateFollowBottom: false;
  remeasureIsAtBottom: true;
  /** Keep the pre-keyboard logical scroll offset; do not chase the end. */
  preserveScrollTop: true;
};

export function visualViewportResizeSync(): VisualViewportResizeSync {
  return {
    scrollToBottom: false,
    mutateScrollIntent: false,
    mutateFollowBottom: false,
    remeasureIsAtBottom: true,
    preserveScrollTop: true,
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

/**
 * Scroll policy when removing message(s) from the list (own delete or realtime).
 *
 * - `follow-bottom`: user was at the end → stay pinned after the list shrinks
 * - `history-anchor`: removed content was above the viewport → compensate scrollTop
 *   by the height delta so the readable message keeps its Y
 * - `preserve`: removal was in/below the viewport → leave scrollTop alone
 */
export type DeleteScrollPolicy = 'follow-bottom' | 'history-anchor' | 'preserve';

export type DeleteScrollPolicyInput = {
  /** Factual viewport position before the removal. */
  wasAtBottom: boolean;
  /** True when any removed row sits entirely above the visible area. */
  removedAboveViewport: boolean;
};

export function deleteScrollPolicy(input: DeleteScrollPolicyInput): DeleteScrollPolicy {
  if (input.wasAtBottom) return 'follow-bottom';
  if (input.removedAboveViewport) return 'history-anchor';
  return 'preserve';
}

/**
 * True when `target` lies entirely above the scroller's visible top edge.
 * Used to decide delete scroll anchoring (TASK-041).
 */
export function isElementAboveViewport(
  scroller: HTMLElement,
  target: HTMLElement,
): boolean {
  const scrollerRect = scroller.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  return targetRect.bottom <= scrollerRect.top + 0.5;
}

/**
 * Height-delta compensation used for history prepend and delete-above.
 * Append-below must NOT use this — it would yank the reader downward.
 * Prefer {@link applyVisualScrollAnchor} when a visible message id is available.
 */
export function compensatedScrollTop(
  scrollTopBefore: number,
  heightBefore: number,
  heightAfter: number,
): number {
  return Math.max(0, scrollTopBefore + (heightAfter - heightBefore));
}

/** Apply a multi-message unread-below delta (burst foreign inserts). */
export function applyUnreadBelowDelta(current: number, insertedCount: number): number {
  if (insertedCount <= 0) return current;
  return current + insertedCount;
}

/**
 * Scroll plan for a coalesced burst of incoming messages (TASK-042).
 *
 * At most one layout scroll adjustment for the whole batch — never one smooth
 * animation per message. Update-only batches (ACK / duplicate) never pin.
 * Honors composer-focus / open-menu preserve from {@link incomingScrollPolicy}.
 */
export type BurstIncomingScrollPlan = {
  policy: IncomingScrollPolicy;
  /** How many programmatic bottom pins the batch may arm (0 or 1). */
  scrollAdjustments: 0 | 1;
};

export function planBurstIncomingScroll(
  wasAtBottom: boolean,
  insertedCount: number,
  composerFocused = false,
  contextMenuOpen = false,
): BurstIncomingScrollPlan {
  if (insertedCount <= 0) {
    return { policy: 'preserve', scrollAdjustments: 0 };
  }
  const policy = incomingScrollPolicy(wasAtBottom, composerFocused, contextMenuOpen);
  return {
    policy,
    scrollAdjustments: policy === 'follow-bottom' ? 1 : 0,
  };
}
