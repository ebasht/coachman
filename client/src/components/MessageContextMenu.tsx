import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { StoredMessage } from '../lib/storage';
import {
  MESSAGE_CONTEXT_MENU_MARGIN_PX,
  canSaveMessageMedia,
  getContextMenuViewport,
  messageClipboardText,
  placeMessageContextMenu,
  type MenuAlignment,
  type RectLike,
} from '../lib/message-context-menu';

export type MessageContextMenuActionId =
  | 'reply'
  | 'copy'
  | 'save'
  | 'delete';

export type MessageContextMenuAction = {
  id: MessageContextMenuActionId;
  label: string;
  danger?: boolean;
};

export type MessageContextMenuProps = {
  message: StoredMessage;
  /** Whole message bubble rect from getBoundingClientRect(). */
  anchorRect: RectLike;
  alignment: MenuAlignment;
  /** Visual stand-in for the selected bubble (Telegram-like highlight). */
  selectedBubble: ReactNode;
  canReply: boolean;
  canDelete: boolean;
  onAction: (id: MessageContextMenuActionId) => void;
  onClose: () => void;
  /** Optional portal mount; defaults to document.body. */
  portalRoot?: Element | null;
};

/** Bumps on each menu history effect so Strict Mode remounts skip rewind. */
let messageContextMenuHistoryGen = 0;

function buildActions(input: {
  message: StoredMessage;
  canReply: boolean;
  canDelete: boolean;
}): MessageContextMenuAction[] {
  const actions: MessageContextMenuAction[] = [];
  if (input.canReply) {
    actions.push({ id: 'reply', label: 'Ответить' });
  }
  const copyText = messageClipboardText(input.message);
  if (copyText) {
    actions.push({
      id: 'copy',
      label: input.message.type === 'text' ? 'Копировать' : 'Копировать текст',
    });
  }
  if (canSaveMessageMedia(input.message)) {
    actions.push({
      id: 'save',
      label: 'Сохранить',
    });
  }
  if (input.canDelete) {
    actions.push({ id: 'delete', label: 'Удалить', danger: true });
  }
  return actions;
}

/**
 * Anchored message context menu (not a bottom sheet).
 * Renders via Portal so overflow of the messages scroller cannot clip it.
 * Opening/closing must not mutate the underlying list scrollTop.
 */
export function MessageContextMenu({
  message,
  anchorRect,
  alignment,
  selectedBubble,
  canReply,
  canDelete,
  onAction,
  onClose,
  portalRoot,
}: MessageContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const closedViaPopRef = useRef(false);
  const [placement, setPlacement] = useState(() =>
    placeMessageContextMenu({
      messageRect: anchorRect,
      menuSize: { width: 180, height: 160 },
      viewport: getContextMenuViewport(),
      alignment,
      margin: MESSAGE_CONTEXT_MENU_MARGIN_PX,
    }),
  );

  const actions = buildActions({ message, canReply, canDelete });

  const recompute = useCallback(() => {
    const el = menuRef.current;
    const menuSize = el
      ? { width: el.offsetWidth, height: el.offsetHeight }
      : { width: 180, height: Math.max(44, actions.length * 44) };
    setPlacement(
      placeMessageContextMenu({
        messageRect: anchorRect,
        menuSize,
        viewport: getContextMenuViewport(),
        alignment,
        margin: MESSAGE_CONTEXT_MENU_MARGIN_PX,
      }),
    );
  }, [anchorRect, alignment, actions.length]);

  useLayoutEffect(() => {
    recompute();
  }, [recompute]);

  useEffect(() => {
    const onResize = () => recompute();
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('scroll', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('scroll', onResize);
    };
  }, [recompute]);

  // Escape + Android/system Back via history (Capacitor backButton uses history.back).
  // Preserve useAppRoute shell state ({ appShell, idx }) so push/pop does not leave the chat.
  // Defer history.back() so React Strict Mode remounts do not immediately onClose (TASK-030).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);

    closedViaPopRef.current = false;
    const gen = ++messageContextMenuHistoryGen;
    const prev = window.history.state;
    const shell =
      prev &&
      typeof prev === 'object' &&
      (prev as { appShell?: boolean }).appShell === true
        ? (prev as { appShell: true; idx: number })
        : { appShell: true as const, idx: 1 };
    const nextState = { ...shell, coachmanMessageContextMenu: gen };
    // Strict Mode remount: replace the entry we just pushed instead of stacking another.
    const alreadyMenu =
      prev &&
      typeof prev === 'object' &&
      typeof (prev as { coachmanMessageContextMenu?: unknown }).coachmanMessageContextMenu ===
        'number';
    if (alreadyMenu) {
      window.history.replaceState(nextState, '');
    } else {
      window.history.pushState(nextState, '');
    }

    const onPop = () => {
      closedViaPopRef.current = true;
      onClose();
    };
    window.addEventListener('popstate', onPop);

    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onPop);
      if (closedViaPopRef.current) return;
      const genAtCleanup = gen;
      queueMicrotask(() => {
        // Strict Mode remount bumped the gen — leave the new entry alone.
        if (messageContextMenuHistoryGen !== genAtCleanup) return;
        const state = window.history.state as {
          coachmanMessageContextMenu?: number;
        } | null;
        if (state?.coachmanMessageContextMenu === genAtCleanup) {
          window.history.back();
        }
      });
    };
  }, [onClose]);

  if (actions.length === 0) return null;

  const bubbleStyle: CSSProperties = {
    position: 'fixed',
    left: anchorRect.left,
    top: anchorRect.top + placement.overlayShiftY,
    width: anchorRect.width,
    minHeight: anchorRect.height,
    zIndex: 1,
    pointerEvents: 'none',
  };

  const menuStyle: CSSProperties = {
    position: 'fixed',
    left: placement.menuLeft,
    top: placement.menuTop,
    zIndex: 2,
  };

  const root = portalRoot ?? document.body;
  return createPortal(
    <div
      className="msg-ctx-root"
      role="presentation"
      data-alignment={alignment}
      data-message-type={message.type}
    >
      <button
        type="button"
        className="msg-ctx-backdrop"
        aria-label="Закрыть меню"
        onClick={onClose}
      />
      <div className="msg-ctx-selected" style={bubbleStyle} aria-hidden>
        {selectedBubble}
      </div>
      <div
        ref={menuRef}
        className={`msg-ctx-menu ${alignment === 'own' ? 'own' : 'incoming'}`}
        style={menuStyle}
        role="menu"
        onClick={(e) => e.stopPropagation()}
      >
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            role="menuitem"
            className={action.danger ? 'danger' : undefined}
            onClick={() => onAction(action.id)}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>,
    root,
  );
}
