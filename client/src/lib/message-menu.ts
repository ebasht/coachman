/**
 * Viewport-aware placement for the per-message context menu (TASK-043).
 * Pure geometry — callers apply the returned placement as CSS / inline style.
 */

export type MessageMenuPlacement = 'above' | 'below';

export type MessageMenuPlaceInput = {
  /** Bubble (or photo) rect in viewport coordinates. */
  anchor: { top: number; bottom: number; left: number; right: number };
  /** Visible scroller (or window) bounds. */
  viewport: { top: number; bottom: number; left: number; right: number };
  /** Estimated menu size. */
  menu: { width: number; height: number };
  /** Gap between bubble and menu. */
  gap?: number;
};

export type MessageMenuPlaceResult = {
  placement: MessageMenuPlacement;
  /** Top edge of the menu in viewport coordinates. */
  top: number;
  /** Left edge of the menu in viewport coordinates. */
  left: number;
  /** True when the menu rectangle is fully inside the viewport. */
  fullyVisible: boolean;
};

/**
 * Prefer below the anchor; flip above when there is not enough room below
 * (message near the bottom of the chat viewport). Clamp horizontally so the
 * menu stays inside the viewport.
 */
export function placeMessageMenu(input: MessageMenuPlaceInput): MessageMenuPlaceResult {
  const gap = input.gap ?? 4;
  const { anchor, viewport, menu } = input;
  const spaceBelow = viewport.bottom - anchor.bottom - gap;
  const spaceAbove = anchor.top - viewport.top - gap;

  let placement: MessageMenuPlacement = 'below';
  if (spaceBelow < menu.height && spaceAbove >= spaceBelow) {
    placement = 'above';
  }

  let top =
    placement === 'below' ? anchor.bottom + gap : anchor.top - gap - menu.height;
  // Soft clamp into viewport if the menu is taller than available space.
  const maxTop = viewport.bottom - menu.height;
  const minTop = viewport.top;
  top = Math.min(Math.max(top, minTop), Math.max(minTop, maxTop));

  // Prefer aligning to the bubble's start; clamp into viewport.
  let left = anchor.left;
  const maxLeft = viewport.right - menu.width;
  left = Math.min(Math.max(left, viewport.left), Math.max(viewport.left, maxLeft));

  const fullyVisible =
    top >= viewport.top - 0.5 &&
    top + menu.height <= viewport.bottom + 0.5 &&
    left >= viewport.left - 0.5 &&
    left + menu.width <= viewport.right + 0.5;

  return { placement, top, left, fullyVisible };
}
