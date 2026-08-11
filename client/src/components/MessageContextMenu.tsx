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
      label: input.message.type === 'video' ? 'Сохранить' : 'Сохранить',
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);

    closedViaPopRef.current = false;
    const marker = { coachmanMessageContextMenu: true as const };
    const previousState = window.history.state;
    window.history.pushState(marker, '');
    const onPop = () => {
      closedViaPopRef.current = true;
      onClose();
    };
    window.addEventListener('popstate', onPop);

    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onPop);
      // Prefer replaceState over history.back(): React Strict Mode remounts would
      // otherwise call back() and fire popstate (closing the menu / fighting routers).
      if (
        !closedViaPopRef.current &&
        window.history.state &&
        typeof window.history.state === 'object' &&
        (window.history.state as { coachmanMessageContextMenu?: boolean })
          .coachmanMessageContextMenu
      ) {
        window.history.replaceState(previousState ?? null, '');
      }
    };
  }, [onClose]);

  if (actions.length === 0) return null;

  const bubbleStyle: CSSProperties = {
    position: 'fixed',
    left: anchorRect.left,
    top: anchorRect.top + placement.overlayShiftY,
    width: anchorRect.width,
    // height follows content; minHeight keeps empty frames from collapsing
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
