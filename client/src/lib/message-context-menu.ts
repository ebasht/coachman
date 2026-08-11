/**
 * Pure geometry helpers for the anchored message context menu (TASK-023–029).
 * Menu is an anchored popup — not a bottom sheet.
 */

/** Gap between the message bubble and the menu / viewport edges (px). */
export const MESSAGE_CONTEXT_MENU_MARGIN_PX = 10;

/** History.state marker for Android/system Back while the message menu is open (MOB-071). */
export const CONTEXT_MENU_HISTORY_KEY = 'coachmanMessageContextMenu' as const;

export type RectLike = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export function isContextMenuHistoryState(state: unknown): boolean {
  return (
    !!state &&
    typeof state === 'object' &&
    (state as { [CONTEXT_MENU_HISTORY_KEY]?: boolean })[CONTEXT_MENU_HISTORY_KEY] === true
  );
}

/**
 * Live bubble rect for an open menu (MOB-014 / MOB-057 / MOB-058).
 * Prefer the real `.message` node so keyboard / rotation reflows re-anchor.
 */
export function measureMessageAnchorRect(
  messageId: string,
  doc: Document = document,
): RectLike | null {
  if (!messageId) return null;
  const escaped =
    typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(messageId)
      : messageId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const el = doc.querySelector(
    `[data-message-id="${escaped}"] .message`,
  ) as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    width: r.width,
    height: r.height,
  };
}

export type ViewportBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

/** Prefer visualViewport when present (mobile IME / pinch-zoom). */
export function getContextMenuViewport(
  win: Window = window,
): ViewportBounds {
  const docEl = win.document?.documentElement;
  const readInset = (prop: string, envFallback: string): number => {
    if (!docEl || typeof win.getComputedStyle !== 'function') return 0;
    const raw = win.getComputedStyle(docEl).getPropertyValue(prop).trim();
    const n = parseFloat(raw);
    if (Number.isFinite(n)) return n;
    // env() may not resolve via getPropertyValue on --sat aliases in all engines.
    void envFallback;
    return 0;
  };
  const padTop = readInset('--sat', 'env(safe-area-inset-top)');
  const padRight = readInset('--sar', 'env(safe-area-inset-right)');
  const padBottom = readInset('--sab', 'env(safe-area-inset-bottom)');
  const padLeft = readInset('--sal', 'env(safe-area-inset-left)');

  const vv = win.visualViewport;
  if (vv) {
    return {
      left: vv.offsetLeft + padLeft,
      top: vv.offsetTop + padTop,
      right: vv.offsetLeft + vv.width - padRight,
      bottom: vv.offsetTop + vv.height - padBottom,
      width: Math.max(0, vv.width - padLeft - padRight),
      height: Math.max(0, vv.height - padTop - padBottom),
    };
  }
  return {
    left: padLeft,
    top: padTop,
    right: win.innerWidth - padRight,
    bottom: win.innerHeight - padBottom,
    width: Math.max(0, win.innerWidth - padLeft - padRight),
    height: Math.max(0, win.innerHeight - padTop - padBottom),
  };
}

export type MenuAlignment = 'own' | 'incoming';

export type ContextMenuPlacement = {
  /** Final menu top-left in viewport coordinates. */
  menuLeft: number;
  menuTop: number;
  /** Vertical shift applied to the selected-message overlay (and menu). */
  overlayShiftY: number;
  /** Whether the menu sits below the message (false → above). */
  placedBelow: boolean;
};

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Position the menu next to the whole message bubble rect.
 * Prefer below; flip above when there is not enough room; clamp to viewport.
 * If message + menu cannot both fit, shift the overlay representation (not the list).
 */
export function placeMessageContextMenu(input: {
  messageRect: RectLike;
  menuSize: { width: number; height: number };
  viewport: ViewportBounds;
  alignment: MenuAlignment;
  margin?: number;
}): ContextMenuPlacement {
  const margin = input.margin ?? MESSAGE_CONTEXT_MENU_MARGIN_PX;
  const { messageRect, menuSize, viewport, alignment } = input;

  const safeLeft = viewport.left + margin;
  const safeRight = viewport.right - margin;
  const safeTop = viewport.top + margin;
  const safeBottom = viewport.bottom - margin;
  const safeHeight = Math.max(0, safeBottom - safeTop);

  const spaceBelow = safeBottom - messageRect.bottom;
  const spaceAbove = messageRect.top - safeTop;

  let placedBelow: boolean;
  if (spaceBelow >= menuSize.height + margin) {
    placedBelow = true;
  } else if (spaceAbove >= menuSize.height + margin) {
    placedBelow = false;
  } else {
    // Prefer the side with more room (composer edge → above, header → below).
    placedBelow = spaceBelow >= spaceAbove;
  }

  let overlayShiftY = 0;
  let menuTop: number;

  if (placedBelow) {
    menuTop = messageRect.bottom + margin;
    const overflow = menuTop + menuSize.height - safeBottom;
    if (overflow > 0) {
      // Shift message+menu up so every action stays on screen.
      overlayShiftY = -Math.min(overflow, Math.max(0, messageRect.top - safeTop));
      menuTop += overlayShiftY;
    }
  } else {
    menuTop = messageRect.top - margin - menuSize.height;
    const underflow = safeTop - menuTop;
    if (underflow > 0) {
      overlayShiftY = Math.min(underflow, Math.max(0, safeBottom - messageRect.bottom));
      menuTop += overlayShiftY;
    }
  }

  // Final vertical clamp if the menu itself is taller than the safe area.
  if (menuSize.height >= safeHeight) {
    menuTop = safeTop;
  } else {
    menuTop = clamp(menuTop, safeTop, safeBottom - menuSize.height);
  }

  // Horizontal: own → right-aligned to bubble; incoming → left-aligned.
  let menuLeft =
    alignment === 'own'
      ? messageRect.right - menuSize.width
      : messageRect.left;
  const maxLeft = Math.max(safeLeft, safeRight - menuSize.width);
  menuLeft = clamp(menuLeft, safeLeft, maxLeft);

  return {
    menuLeft,
    menuTop,
    overlayShiftY,
    placedBelow,
  };
}

/** Whether a message exposes a meaningful copyable caption / body. */
export function messageClipboardText(message: {
  type: string;
  text?: string;
}): string | null {
  const raw = (message.text || '').trim();
  if (!raw) return null;
  if (raw.startsWith('[')) return null;
  if (message.type === 'text') return raw;
  if (message.type === 'image' || message.type === 'video') {
    // Placeholder labels are not captions.
    if (/^📷/.test(raw) || /^🎬/.test(raw)) return null;
    if (raw === 'Изображение' || raw === 'Видео' || raw === 'Фото') return null;
    return raw;
  }
  return null;
}

export function canSaveMessageMedia(message: {
  type: string;
  imageUrl?: string | null;
}): boolean {
  return (message.type === 'image' || message.type === 'video') && !!message.imageUrl;
}
