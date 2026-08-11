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
  measureMessageAnchorRect,
  messageClipboardText,
  placeMessageContextMenu,
  type MenuAlignment,
  type RectLike,
} from '../lib/message-context-menu';
import {
  claimContextMenuHistory,
  releaseContextMenuHistory,
} from '../lib/message-context-menu-history';

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

function sameRect(a: RectLike, b: RectLike): boolean {
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.right === b.right &&
    a.bottom === b.bottom &&
    a.width === b.width &&
    a.height === b.height
  );
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
  const [liveAnchor, setLiveAnchor] = useState<RectLike>(anchorRect);
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

  const resolveAnchor = useCallback((): RectLike => {
    // MOB-057 / MOB-058: remeasure the real bubble under keyboard / rotation.
    return measureMessageAnchorRect(message.id) ?? anchorRect;
  }, [message.id, anchorRect]);

  const recompute = useCallback(() => {
    const nextAnchor = resolveAnchor();
    setLiveAnchor((prev) => (sameRect(prev, nextAnchor) ? prev : nextAnchor));
    const el = menuRef.current;
    const menuSize = el
      ? { width: el.offsetWidth, height: el.offsetHeight }
      : { width: 180, height: Math.max(44, actions.length * 44) };
    setPlacement(
      placeMessageContextMenu({
        messageRect: nextAnchor,
        menuSize,
        viewport: getContextMenuViewport(),
        alignment,
        margin: MESSAGE_CONTEXT_MENU_MARGIN_PX,
      }),
    );
  }, [resolveAnchor, alignment, actions.length]);

  useLayoutEffect(() => {
    setLiveAnchor(anchorRect);
  }, [anchorRect]);

  useLayoutEffect(() => {
    recompute();
  }, [recompute]);

  useEffect(() => {
    const onResize = () => recompute();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('scroll', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
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
    const { epoch } = claimContextMenuHistory();
    const onPop = () => {
      closedViaPopRef.current = true;
      onClose();
    };
    window.addEventListener('popstate', onPop);

    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onPop);
      releaseContextMenuHistory({
        epoch,
        closedViaPop: closedViaPopRef.current,
      });
    };
  }, [onClose]);

  if (actions.length === 0) return null;

  const bubbleStyle: CSSProperties = {
    position: 'fixed',
    left: liveAnchor.left,
    top: liveAnchor.top + placement.overlayShiftY,
    width: liveAnchor.width,
    // height follows content; minHeight keeps empty frames from collapsing
    minHeight: liveAnchor.height,
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
