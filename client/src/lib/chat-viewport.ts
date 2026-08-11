/**
 * Shared chat message-list viewport metrics.
 * One threshold / formula for “are we at the bottom?” across ChatView scroll logic.
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
  /** Within {@link BOTTOM_THRESHOLD_PX} of the end — stick / follow bottom. */
  isAtBottom: boolean;
  /** Any content remains below the viewport (even within the threshold). */
  hasMessagesBelow: boolean;
};

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
