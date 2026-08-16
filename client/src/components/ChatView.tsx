import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import type { Chat, RawMessage } from '../lib/api';
import { api } from '../lib/api';
import type { StoredMessage } from '../lib/storage';
import { getMessages, saveMessage, saveMessages, deleteMessageLocal, loadGroupKeyEpoch } from '../lib/storage';
import { decryptMessage } from '../lib/messages';
import {
  HISTORY_PAGE_SIZE,
  findMatchingPending,
  historyFetchMode,
  indexMessagesById,
  maxMessageSequence,
  minMessageSequence,
  pageMayHaveOlder,
  shouldReuseCachedMessage,
  sliceRecentMessages,
  takeOlderChunk,
} from '../lib/chat-history-sync';
import { encryptChatMessage, getChatEncryptionKey, PLAIN_IV } from '../lib/messages-encrypt';
import { shouldRefreshGroupKeyOnLoad } from '../lib/push-live';
import { prepareChatImage, compressChatImage } from '../lib/image';
import { hydrateStoredMessages, migrateLocalPreview, persistLocalPreview } from '../lib/image-preview';
import { scheduleMissingMediaHydration, type MediaHydrateContext } from '../lib/media-hydrate';
import { enqueueImageOutbox, enqueueVideoOutbox, flushOutbox, sendTextMessage, retryOutboxItem, isOfflineError, isForbiddenError, OUTBOX_FLUSHED_EVENT, OUTBOX_FAILED_EVENT } from '../lib/outbox';
import { isOnline } from '../lib/network';
import { formatDateDivider, formatMessageTime, isFirstInMessageGroup, isLastInMessageGroup, isSameDay, chatInitials, peerStatusText, albumRange } from '../lib/chat-format';
import { callEventDisplayText } from '../lib/call-events';
import { listEventDisplayText } from '../lib/list-events';
import { dedupeStoredMessages, upsertMessageInList } from '../lib/message-dedupe';
import { reconcileMessages } from '../lib/message-reconcile';
import type { LiveMessageBatch } from '../lib/live-message-batch';
import { compareMessages, upsertStoredMessage } from '../lib/message-upsert';
import {
  buildReplySnapshot,
  canReplyToMessage,
  fillReplySnapshots,
  findMessageById,
  findReplyTargetElement,
  REPLY_TARGET_HIGHLIGHT_MS,
  type ReplySnapshot,
} from '../lib/message-reply';
import { notify } from '../lib/notify';
import { captureVideoPoster } from '../lib/video-poster';
import { persistVideoPoster } from '../lib/video-preview';
import { GroupMembersModal } from './GroupMembersModal';
import { LinkPreview } from './LinkPreview';
import { MessageText } from './MessageText';
import { MessageStatus } from './MessageStatus';
import { MessageReplyQuote } from './MessageReplyQuote';
import { ChatImageBubble } from './ChatImageBubble';
import { ChatVideoBubble } from './ChatVideoBubble';
import { ChatImageAlbum } from './ChatImageAlbum';
import { UserAvatar } from './UserAvatar';
import { ChatAvatar } from './ChatAvatar';
import { ImageLightbox } from './ImageLightbox';
import { VideoLightbox } from './VideoLightbox';
import { ConfirmDialog } from './ConfirmDialog';
import { ChatListsModal, type ChatListEvent } from './ChatListsModal';
import { checkListUnreadFromServer, clearListUnread } from '../lib/list-sync';
import { syncSystemGroupKeys } from '../lib/system-group';
import {
  applyUnreadBelowCount,
  applyUnreadBelowDelta,
  applyVisualScrollAnchor,
  captureVisualScrollAnchor,
  composerResizeSync,
  createRafCoalescer,
  deleteScrollPolicy,
  followBottomOutcome,
  formatUnreadBelowBadge,
  isBottomTargetingIntent,
  isElementAboveViewport,
  measureChatViewport,
  messageAnchorSelector,
  planBurstIncomingScroll,
  shouldArmOwnMessageScroll,
  shouldBumpUnreadBelowForIncoming,
  shouldFollowBottomForIncomingOwnMessage,
  initialLoadScrollPolicy,
  shouldFollowBottomOnMediaLayout,
  shouldFollowBottomOnMessagesUpdate,
  shouldWipeChatMessagesOnMetaChange,
  syncFromUserScroll,
  visualViewportResizeSync,
  type ChatScrollIntent,
  type VisualScrollAnchor,
} from '../lib/chat-viewport';
import { isVisualViewportShellActive } from '../hooks/useVisualViewport';
import { useMessageGestures } from '../hooks/useMessageGestures';
import {
  MessageContextMenu,
  type MessageContextMenuActionId,
} from './MessageContextMenu';
import { messageClipboardText, canSaveMessageMedia } from '../lib/message-context-menu';
import { saveChatImage } from '../lib/save-image';
import { sameMessageIdentity } from '../lib/message-identity';

const MAX_VIDEO_BYTES = 100 << 20;
const MAX_VIDEOS_PER_PICK = 5;
const VIDEO_ACCEPT = 'video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov';
const MEDIA_ACCEPT = `image/*,${VIDEO_ACCEPT}`;

function isVideoFile(file: File): boolean {
  const type = (file.type || '').toLowerCase();
  if (type.startsWith('video/')) return true;
  return /\.(mp4|webm|mov)$/i.test(file.name || '');
}

interface Props {
  chat: Chat;
  userId: string;
  privateKey: CryptoKey;
  privateKeyB64: string;
  isAdmin?: boolean;
  onBack?: () => void;
  onMembersChanged: (left?: boolean) => void;
  onClearChat?: () => void;
  canClearChat?: boolean;
  onDeleteChat?: () => void;
  canDeleteChat?: boolean;
  onRead?: (at: number) => void;
  /** Frame-coalesced realtime upserts (TASK-042). Prefer over per-message props. */
  incomingMessageBatch?: LiveMessageBatch | null;
  /** @deprecated Prefer {@link incomingMessageBatch}; kept for single-message callers. */
  incomingMessage?: StoredMessage | null;
  deletedMessage?: { chatId: string; messageId: string } | null;
  peerTyping?: boolean;
  typingUserId?: string | null;
  onTypingChange?: (isTyping: boolean) => void;
  onMessagesChanged?: () => void;
  onStartVideoCall?: () => void;
  listEvent?: (ChatListEvent & { seq?: number }) | null;
  listUnread?: boolean;
  onListUnreadChange?: (unread: boolean) => void;
  onListSystemMessage?: (msg: StoredMessage) => void;
  /** Parent bumps this to force a history re-fetch (e.g. after push wake). */
  syncTick?: number;
  /** Photos received via Web Share Target — send once, then notify parent. */
  sharedFiles?: File[] | null;
  onSharedFilesConsumed?: () => void;
}

export function ChatView({
  chat,
  userId,
  privateKey,
  privateKeyB64,
  isAdmin = false,
  onBack,
  onMembersChanged,
  onClearChat,
  canClearChat = false,
  onDeleteChat,
  canDeleteChat = false,
  onRead,
  incomingMessageBatch = null,
  incomingMessage,
  deletedMessage,
  peerTyping = false,
  typingUserId = null,
  onTypingChange,
  onMessagesChanged,
  onStartVideoCall,
  listEvent = null,
  listUnread = false,
  onListUnreadChange,
  onListSystemMessage,
  syncTick = 0,
  sharedFiles = null,
  onSharedFilesConsumed,
}: Props) {
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  /** True until the first local/network paint for this chat open. */
  const [historyLoading, setHistoryLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  /** Ascending local rows older than the visible window (not yet mounted). */
  const olderLocalRef = useRef<StoredMessage[]>([]);
  /** Server may still have rows older than the oldest mounted message. */
  const hasOlderRemoteRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const historyLoadGenRef = useRef(0);
  const typingIdleRef = useRef<number | undefined>(undefined);
  const typingActiveRef = useRef(false);

  const [showMembers, setShowMembers] = useState(false);
  const [showLists, setShowLists] = useState(false);
  const showListsRef = useRef(false);
  showListsRef.current = showLists;
  const onListUnreadChangeRef = useRef(onListUnreadChange);
  onListUnreadChangeRef.current = onListUnreadChange;
  const listsAllowed = !chat.isSystem;
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    messageId: string;
    clientId?: string;
    anchorRect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  } | null>(null);
  const [replyTo, setReplyTo] = useState<ReplySnapshot | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{
    images: { src: string; imageId?: string | null; messageId?: string | null }[];
    index: number;
  } | null>(null);
  const [videoLightbox, setVideoLightbox] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StoredMessage | null>(null);
  /**
   * Logical foreign messages arrived while the user was above the end (↓ FAB badge).
   * Incremented only on `inserted === true` ops — never on ACK / duplicate / echo.
   * Reset only when the user reaches the end manually or taps ↓.
   */
  const [unreadBelowCount, setUnreadBelowCount] = useState(0);
  /** UI mirror of {@link isAtBottomRef} — drives the scroll-to-latest FAB. */
  const [isAtBottom, setIsAtBottom] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const headerMenuRef = useRef<HTMLDivElement>(null);
  /** Factual viewport position — updated from measurements / scroll only. */
  const isAtBottomRef = useRef(true);
  /** Permission to keep anchoring to the bottom as content grows. */
  const followBottomRef = useRef(true);
  /** Explicit programmatic navigation reason (orthogonal to the two flags above). */
  const scrollIntentRef = useRef<ChatScrollIntent>('initial');
  /**
   * While true, scroll events come from our own scrollTop/scrollIntoView writes.
   * Those must not be treated as user gestures (follow permission / unread reset).
   */
  const programmaticScrollRef = useRef(false);
  const programmaticScrollClearTimerRef = useRef<number | undefined>(undefined);
  const openingChatRef = useRef(true);
  const initialLoadRef = useRef(true);
  /**
   * Opt-in history-prepend anchor (TASK-019): message id + Y, with scrollHeight fallback.
   */
  const scrollAnchorRef = useRef<VisualScrollAnchor | null>(null);
  /**
   * Live visual anchor refreshed on user scroll / stable layout — used when late
   * media / child resize changes height above the viewport (TASK-021).
   */
  const liveVisualAnchorRef = useRef<VisualScrollAnchor | null>(null);
  /**
   * Pre-layout at-bottom fact for ResizeObserver / media `load` (TASK-020).
   * Updated only from stable measurements — never from a mid-resize guess.
   */
  const layoutWasAtBottomRef = useRef(true);
  /** Shared message-list ResizeObserver — children re-observed as rows mount. */
  const messagesResizeObserverRef = useRef<ResizeObserver | null>(null);
  /**
   * Armed by {@link updateMessages} when the next messages commit must pin to end.
   * Messages-array changes alone are not a scroll command — only this flag (or an
   * explicit history-anchor) may mutate scrollTop from the layout effect.
   */
  const pendingPinToBottomRef = useRef(false);
  /**
   * Coalesces trailing follow-bottom / media-layout pins to one rAF jump so a
   * burst of incoming messages does not stack dozens of scroll adjustments.
   */
  const followBottomScrollCoalescerRef = useRef(createRafCoalescer());
  const fileRef = useRef<HTMLInputElement>(null);
  const sendImagesRef = useRef<(files: FileList | File[]) => Promise<void>>(async () => {});
  const sendMediaRef = useRef<(files: FileList | File[]) => Promise<void>>(async () => {});
  const composeRef = useRef<HTMLTextAreaElement>(null);
  /**
   * True while the compose textarea has focus (TASK-016).
   * Incoming upserts must not force-scroll the feed during active typing —
   * even if the viewport was previously near the end.
   */
  const composerFocusedRef = useRef(false);
  /**
   * Logical messages `scrollTop` locked when the composer gains focus (TASK-018).
   * visualViewport / IME open↔close and browser scroll-into-view must not move
   * the feed; intentional pins refresh this lock.
   */
  const keyboardScrollTopLockRef = useRef<number | null>(null);
  /** Latest messages for gesture / reply-target callbacks without stale closures. */
  const messagesSnapshotRef = useRef<StoredMessage[]>([]);
  messagesSnapshotRef.current = messages;
  const contextMenuOpenRef = useRef(false);
  contextMenuOpenRef.current = !!contextMenu;
  const openContextMenuForGestureRef = useRef<(m: StoredMessage, el: HTMLElement) => void>(
    () => {},
  );
  const beginReplyForGestureRef = useRef<(m: StoredMessage) => void>(() => {});

  const {
    isSwipeIconVisible,
    rowSwipeStyle,
    bindMessageGestures,
    setBubbleEl,
    consumeSuppressClick,
    resetGestures,
  } = useMessageGestures({
    onLongPress: (messageId, anchorEl) => {
      const m = findMessageById(messagesSnapshotRef.current, messageId);
      if (!m) return;
      openContextMenuForGestureRef.current(m, anchorEl);
    },
    onSwipeReply: (messageId) => {
      const m = findMessageById(messagesSnapshotRef.current, messageId);
      if (!m) return;
      beginReplyForGestureRef.current(m);
    },
  });

  const resizeCompose = useCallback(() => {
    const el = composeRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, []);

  /** Keep ref + React state for viewport bottom in sync (FAB visibility). */
  const publishIsAtBottom = useCallback((next: boolean) => {
    isAtBottomRef.current = next;
    setIsAtBottom((prev) => (prev === next ? prev : next));
  }, []);

  useLayoutEffect(() => {
    resizeCompose();
    // TASK-017: composer grow/shrink updates `.messages` flex height. Remeasure
    // isAtBottom for ↓ — never scrollToEnd, never touch follow/scrollIntent.
    const sync = composerResizeSync();
    if (!sync.remeasureIsAtBottom) return;
    const el = messagesRef.current;
    if (!el || openingChatRef.current || initialLoadRef.current) return;
    publishIsAtBottom(measureChatViewport(el).isAtBottom);
  }, [text, resizeCompose, publishIsAtBottom]);

  /** Mark upcoming scroll mutations as app-driven (not user scroll). */
  const beginProgrammaticScroll = useCallback((clearAfterMs = 64) => {
    programmaticScrollRef.current = true;
    if (programmaticScrollClearTimerRef.current !== undefined) {
      window.clearTimeout(programmaticScrollClearTimerRef.current);
    }
    programmaticScrollClearTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticScrollClearTimerRef.current = undefined;
    }, clearAfterMs);
  }, []);

  const pinViewportToEnd = useCallback(() => {
    const el = messagesRef.current;
    if (!el) return;
    beginProgrammaticScroll();
    el.scrollTop = el.scrollHeight;
    // Intentional pin owns the keyboard lock so IME settle cannot rewind it.
    if (composerFocusedRef.current || keyboardScrollTopLockRef.current !== null) {
      keyboardScrollTopLockRef.current = el.scrollTop;
    }
    publishIsAtBottom(true);
    layoutWasAtBottomRef.current = true;
    liveVisualAnchorRef.current = captureVisualScrollAnchor(el);
  }, [beginProgrammaticScroll, publishIsAtBottom]);

  /**
   * Pin to end now (layout-safe), and coalesce at most one trailing rAF pass for
   * late layout. Burst callers share the trailing frame instead of stacking N.
   */
  const scrollToEnd = useCallback(() => {
    pinViewportToEnd();
    followBottomScrollCoalescerRef.current.schedule(pinViewportToEnd);
  }, [pinViewportToEnd]);

  /** Follow-bottom only: coalesce the whole adjustment onto one animation frame. */
  const scheduleFollowBottomScroll = useCallback(() => {
    followBottomRef.current = true;
    // Optimistic: ↓ must not flash between append and the coalesced pin.
    publishIsAtBottom(true);
    followBottomScrollCoalescerRef.current.schedule(pinViewportToEnd);
  }, [pinViewportToEnd, publishIsAtBottom]);

  const updateMessages = useCallback((
    updater: StoredMessage[] | ((prev: StoredMessage[]) => StoredMessage[]),
    opts?: { followBottom?: boolean; scrollIntent?: ChatScrollIntent },
  ) => {
    const el = messagesRef.current;
    // TASK-043: open/initial auto-pin only while follow stays armed. A mid-load
    // scroll-up clears followBottom and must not be re-armed by bare mutations.
    const shouldFollow = shouldFollowBottomOnMessagesUpdate({
      explicitFollowBottom: opts?.followBottom,
      inInitialLoad: openingChatRef.current || initialLoadRef.current,
      followBottom: followBottomRef.current,
    });
    if (shouldFollow) {
      followBottomRef.current = true;
      pendingPinToBottomRef.current = true;
      // Optimistic at-bottom so ↓ / unread stay quiet until the pin lands.
      publishIsAtBottom(true);
      if (opts?.scrollIntent) {
        scrollIntentRef.current = opts.scrollIntent;
      } else if (openingChatRef.current || initialLoadRef.current) {
        scrollIntentRef.current = 'initial';
      }
    } else if (opts?.scrollIntent === 'history-anchor' && el) {
      // Opt-in only: prepend / full-history rewrite above the viewport.
      // Never arm this for append-below (incoming) — height delta would yank scrollTop down.
      // TASK-019: prefer visible message id + getBoundingClientRect().top.
      scrollIntentRef.current = 'history-anchor';
      const anchor = captureVisualScrollAnchor(el);
      scrollAnchorRef.current = anchor;
      liveVisualAnchorRef.current = anchor;
      pendingPinToBottomRef.current = false;
    } else if (opts?.scrollIntent) {
      scrollIntentRef.current = opts.scrollIntent;
      pendingPinToBottomRef.current = false;
    } else {
      // Default: messages mutation is not a scroll command.
      pendingPinToBottomRef.current = false;
      scrollAnchorRef.current = null;
    }
    setMessages(updater);
  }, [publishIsAtBottom]);

  /** Arm scroll policy for a delete of the given message ids (TASK-041). */
  const scrollOptsForDelete = useCallback((removedIds: string[]) => {
    const el = messagesRef.current;
    const wasAtBottom = isAtBottomRef.current;
    let removedAboveViewport = false;
    if (el) {
      for (const id of removedIds) {
        const node = el.querySelector(messageAnchorSelector(id));
        if (node instanceof HTMLElement && isElementAboveViewport(el, node)) {
          removedAboveViewport = true;
          break;
        }
      }
    }
    const policy = deleteScrollPolicy({ wasAtBottom, removedAboveViewport });
    if (policy === 'follow-bottom') return { followBottom: true as const };
    if (policy === 'history-anchor') return { scrollIntent: 'history-anchor' as const };
    return undefined;
  }, []);

  const usernames = new Map(chat.members.map((m) => [m.id, m.username]));
  const myGroupWrap = chat.members.find((m) => m.id === userId)?.encryptedGroupKey ?? '';

  /** Fill photo/video stubs in the background after text rows are already on screen. */
  const hydrateMissingMedia = useCallback(
    (rows: StoredMessage[], chatForDecrypt: Chat = chat) => {
      const ctx: MediaHydrateContext = {
        chat: chatForDecrypt,
        myUserId: userId,
        myPrivateKeyB64: privateKeyB64,
      };
      scheduleMissingMediaHydration(rows, ctx, (patch) => {
        if (patch.chatId !== chat.id) return;
        updateMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === patch.id);
          if (idx < 0) return prev;
          const cur = prev[idx]!;
          if (cur.imageUrl && (!patch.posterUrl || cur.posterUrl)) return prev;
          const copy = prev.slice();
          copy[idx] = {
            ...cur,
            imageUrl: patch.imageUrl || cur.imageUrl,
            posterUrl: patch.posterUrl || cur.posterUrl,
          };
          return copy;
        });
      });
    },
    [chat, userId, privateKeyB64, updateMessages],
  );

  const materializeRawMessages = useCallback(
    async (
      raw: RawMessage[],
      chatForDecrypt: Chat,
      nameById: Map<string, string>,
      cached: StoredMessage[],
    ): Promise<StoredMessage[]> => {
      const cachedById = indexMessagesById(cached);
      const decrypted: StoredMessage[] = [];
      const toPersist: StoredMessage[] = [];

      for (const msg of raw) {
        try {
          const existing = cachedById.get(msg.id);
          if (shouldReuseCachedMessage(existing, msg)) {
            const [hydrated] = await hydrateStoredMessages([
              {
                ...existing!,
                clientId: msg.clientId || existing!.clientId,
                sequence: msg.sequence ?? existing!.sequence,
                albumId: msg.albumId ?? existing!.albumId,
                replyToMessageId: msg.replyToMessageId ?? existing!.replyToMessageId,
              },
            ]);
            decrypted.push(hydrated);
            continue;
          }
          if (msg.senderId === userId) {
            const pending = findMatchingPending(cached, msg, userId);
            if (pending) {
              const stored: StoredMessage = {
                ...pending,
                id: msg.id,
                createdAt: msg.createdAt,
                pending: false,
                imageId: msg.imageId,
                albumId: msg.albumId ?? pending.albumId,
                replyToMessageId: msg.replyToMessageId ?? pending.replyToMessageId,
                clientId: msg.clientId || pending.clientId || pending.id,
                sequence: msg.sequence,
              };
              if (msg.type === 'image' && msg.imageId) {
                await migrateLocalPreview(pending.id, msg.id, msg.imageId);
              }
              const hydrated = (await hydrateStoredMessages([stored]))[0];
              const merged = await upsertStoredMessage(hydrated);
              decrypted.push(merged);
              continue;
            }
          }
          const { text: plain } = await decryptMessage(
            msg,
            chatForDecrypt,
            userId,
            privateKeyB64,
            nameById,
          );
          if (msg.senderId === userId && plain === '[ваше сообщение]') continue;
          if (
            plain === '[не удалось расшифровать]' &&
            existing &&
            existing.text &&
            !existing.text.startsWith('[')
          ) {
            decrypted.push(existing);
            continue;
          }
          const stored: StoredMessage = {
            id: msg.id,
            chatId: msg.chatId,
            senderId: msg.senderId,
            senderName: nameById.get(msg.senderId) || '?',
            text: plain,
            type: msg.type,
            imageId: msg.imageId,
            albumId: msg.albumId,
            replyToMessageId: msg.replyToMessageId,
            clientId: msg.clientId,
            sequence: msg.sequence,
            createdAt: msg.createdAt,
          };
          if (plain !== '[не удалось расшифровать]') {
            toPersist.push(stored);
          }
          const [hydrated] = await hydrateStoredMessages([stored]);
          decrypted.push(hydrated);
        } catch {
          // One bad message must not abort the whole history load (iOS PWA).
        }
      }

      if (toPersist.length) {
        try {
          await saveMessages(toPersist);
        } catch {
          for (const m of toPersist) {
            try {
              await saveMessage(m);
            } catch {
              /* ignore */
            }
          }
        }
      }

      const withReplies = fillReplySnapshots(decrypted);
      for (const m of withReplies) {
        if (m.replyToMessageId && m.replyToPreview) {
          try {
            await saveMessage(m);
          } catch {
            /* ignore */
          }
        }
      }
      return withReplies;
    },
    [privateKeyB64, userId],
  );

  const loadAndDecrypt = useCallback(async () => {
    const loadGen = ++historyLoadGenRef.current;
    const nameById = new Map(chat.members.map((m) => [m.id, m.username]));
    const cachedRaw = dedupeStoredMessages(await getMessages(chat.id)).sort(compareMessages);
    if (loadGen !== historyLoadGenRef.current) return;

    try {
      if (cachedRaw.length) {
        const { visible, older } = sliceRecentMessages(cachedRaw);
        olderLocalRef.current = older;
        // May still have older rows on the server if this device only kept a partial cache.
        hasOlderRemoteRef.current = true;
        const hydrated = await hydrateStoredMessages(visible);
        if (loadGen !== historyLoadGenRef.current) return;
        updateMessages(
          hydrated,
          openingChatRef.current && followBottomRef.current
            ? { followBottom: true, scrollIntent: 'initial' }
            : { scrollIntent: 'history-anchor' },
        );
        setHistoryLoading(false);
        // Paint stubs immediately; download photos/videos after text is visible.
        hydrateMissingMedia(hydrated, chat);
      }

      // Always attempt network — Capacitor Android often reports navigator.onLine=false.
      // Warm group key so encrypted history decrypts. Skip getChats + forceRefresh
      // when the wrap is present and the epoch has not changed.
      let chatForDecrypt = chat;
      if (chat.type === 'group') {
        try {
          const me = chat.members.find((m) => m.id === userId);
          const localEpoch = await loadGroupKeyEpoch(userId, chat.id);
          const needsKeySync = shouldRefreshGroupKeyOnLoad({
            isGroup: true,
            wrapMissing: !me?.encryptedGroupKey,
            localEpoch,
            serverEpoch: chat.groupKeyEpoch,
          });
          if (needsKeySync) {
            const freshList = await api.getChats();
            const fresh = freshList.find((c) => c.id === chat.id);
            if (fresh) chatForDecrypt = fresh;
            if (chatForDecrypt.isSystem) {
              const repaired = await syncSystemGroupKeys([chatForDecrypt], userId, privateKeyB64);
              if (repaired) {
                const again = (await api.getChats()).find((c) => c.id === chat.id);
                if (again) chatForDecrypt = again;
              }
            }
          }
          await getChatEncryptionKey(chatForDecrypt, userId, privateKeyB64, {
            forceRefresh: needsKeySync,
          });
        } catch {
          // Messages may still load once wrap/key is available.
        }
      }
      if (loadGen !== historyLoadGenRef.current) return;

      const mode = historyFetchMode(cachedRaw);
      let raw: RawMessage[] = [];
      if (mode === 'incremental') {
        // Catch up only — do not re-download / re-decrypt the whole history.
        raw = await api.getAllMessagesAfterSequence(chat.id, maxMessageSequence(cachedRaw));
      } else {
        // Cold open: newest page first (not oldest-first full backfill).
        raw = await api.getLatestMessages(chat.id, HISTORY_PAGE_SIZE);
        hasOlderRemoteRef.current = pageMayHaveOlder(raw.length);
      }
      if (loadGen !== historyLoadGenRef.current) return;

      if (!raw.length) {
        if (!cachedRaw.length) {
          updateMessages([], { followBottom: true, scrollIntent: 'initial' });
        }
        const latest = cachedRaw
          .filter((m) => !m.pending)
          .reduce((max, m) => Math.max(max, m.createdAt), 0);
        if (latest > 0) onRead?.(latest);
        return;
      }

      const materialized = await materializeRawMessages(raw, chatForDecrypt, nameById, cachedRaw);
      if (loadGen !== historyLoadGenRef.current) return;

      if (materialized.length) {
        const stillPendingIds = new Set(
          (await getMessages(chat.id)).filter((m) => m.pending).map((m) => m.id),
        );
        if (loadGen !== historyLoadGenRef.current) return;
        updateMessages((prev) => {
          const map = new Map(
            prev.filter((m) => !m.pending && !m.provisional).map((m) => [m.id, m]),
          );
          for (const m of materialized) map.set(m.id, m);
          const confirmed = [...map.values()];
          const pending = prev.filter((m) => m.pending && stillPendingIds.has(m.id));
          const pendingDeduped = pending.filter(
            (p) =>
              !confirmed.some(
                (c) =>
                  !c.pending &&
                  !!p.clientId &&
                  (c.clientId === p.clientId ||
                    c.id === p.clientId ||
                    p.id === `pending-${c.clientId}`),
              ),
          );
          return dedupeStoredMessages([...confirmed, ...pendingDeduped]);
        }, followBottomRef.current
          ? { followBottom: true }
          : { scrollIntent: 'history-anchor' });
        hydrateMissingMedia(materialized, chatForDecrypt);
      }

      const all = await getMessages(chat.id);
      const latest = all.filter((m) => !m.pending).reduce((max, m) => Math.max(max, m.createdAt), 0);
      if (latest > 0) onRead?.(latest);
    } catch {
      const latest = cachedRaw.filter((m) => !m.pending).reduce((max, m) => Math.max(max, m.createdAt), 0);
      if (latest > 0) onRead?.(latest);
    } finally {
      if (loadGen === historyLoadGenRef.current) {
        setHistoryLoading(false);
        initialLoadRef.current = false;
        openingChatRef.current = false;
        // TASK-043: honor mid-load scroll-up. Opening-at-start must not force pin.
        const el = messagesRef.current;
        const measuredAtBottom = el ? measureChatViewport(el).isAtBottom : isAtBottomRef.current;
        if (initialLoadScrollPolicy(followBottomRef.current) === 'follow-bottom') {
          followBottomRef.current = true;
          publishIsAtBottom(true);
          scrollToEnd();
        } else {
          followBottomRef.current = false;
          scrollIntentRef.current = 'none';
          publishIsAtBottom(measuredAtBottom);
        }
      }
    }
  }, [
    chat,
    userId,
    privateKeyB64,
    onRead,
    updateMessages,
    scrollToEnd,
    publishIsAtBottom,
    materializeRawMessages,
    hydrateMissingMedia,
  ]);

  const loadOlderMessages = useCallback(async () => {
    if (loadingOlderRef.current) return;
    if (!olderLocalRef.current.length && !hasOlderRemoteRef.current) return;

    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      if (olderLocalRef.current.length) {
        const { chunk, remaining } = takeOlderChunk(olderLocalRef.current);
        olderLocalRef.current = remaining;
        const hydrated = await hydrateStoredMessages(chunk);
        updateMessages(
          (prev) => dedupeStoredMessages([...hydrated, ...prev]),
          { scrollIntent: 'history-anchor' },
        );
        hydrateMissingMedia(hydrated);
        return;
      }

      const nameById = new Map(chat.members.map((m) => [m.id, m.username]));
      const beforeSeq = minMessageSequence(messagesSnapshotRef.current);
      if (beforeSeq <= 0) {
        hasOlderRemoteRef.current = false;
        return;
      }

      const raw = await api.getMessagesBefore(chat.id, beforeSeq, HISTORY_PAGE_SIZE);
      hasOlderRemoteRef.current = pageMayHaveOlder(raw.length);
      if (!raw.length) return;

      const materialized = await materializeRawMessages(
        raw,
        chat,
        nameById,
        messagesSnapshotRef.current,
      );
      if (!materialized.length) return;
      updateMessages(
        (prev) => dedupeStoredMessages([...materialized, ...prev]),
        { scrollIntent: 'history-anchor' },
      );
      hydrateMissingMedia(materialized);
    } catch {
      /* keep hasOlderRemote so the user can retry by scrolling again */
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [chat, materializeRawMessages, updateMessages, hydrateMissingMedia]);

  /** Ensure a reply parent is mounted (local buffer → IDB → remote older pages). */
  const ensureMessageLoaded = useCallback(
    async (messageId: string): Promise<boolean> => {
      if (!messageId) return false;
      if (findMessageById(messagesSnapshotRef.current, messageId)) return true;

      const olderIdx = olderLocalRef.current.findIndex((m) => m.id === messageId);
      if (olderIdx >= 0) {
        const needed = olderLocalRef.current.slice(olderIdx);
        olderLocalRef.current = olderLocalRef.current.slice(0, olderIdx);
        const hydrated = await hydrateStoredMessages(needed);
        updateMessages(
          (prev) => dedupeStoredMessages([...hydrated, ...prev]),
          { scrollIntent: 'history-anchor' },
        );
        return true;
      }

      const allLocal = dedupeStoredMessages(await getMessages(chat.id)).sort(compareMessages);
      const targetIdx = allLocal.findIndex((m) => m.id === messageId);
      if (targetIdx >= 0) {
        const oldestVisibleId = messagesSnapshotRef.current[0]?.id;
        const oldestVisibleIdx = oldestVisibleId
          ? allLocal.findIndex((m) => m.id === oldestVisibleId)
          : allLocal.length;
        const end = oldestVisibleIdx >= 0 ? oldestVisibleIdx : allLocal.length;
        const bridge = allLocal.slice(targetIdx, Math.max(end, targetIdx + 1));
        olderLocalRef.current = allLocal.slice(0, targetIdx);
        const hydrated = await hydrateStoredMessages(bridge);
        updateMessages(
          (prev) => dedupeStoredMessages([...hydrated, ...prev]),
          { scrollIntent: 'history-anchor' },
        );
        return true;
      }

      for (let i = 0; i < 50; i++) {
        if (!hasOlderRemoteRef.current && !olderLocalRef.current.length) break;
        const beforeCount = messagesSnapshotRef.current.length;
        await loadOlderMessages();
        if (findMessageById(messagesSnapshotRef.current, messageId)) return true;
        if (messagesSnapshotRef.current.length === beforeCount) break;
      }
      return !!findMessageById(messagesSnapshotRef.current, messageId);
    },
    [chat.id, loadOlderMessages, updateMessages],
  );

  const historyChatIdRef = useRef<string | null>(null);
  useEffect(() => {
    // Remount via key={chat.id} already resets state; this path also covers
    // wrap/epoch changes on the same mounted instance (slow iOS PWA key sync).
    const wipe = shouldWipeChatMessagesOnMetaChange(historyChatIdRef.current, chat.id);
    historyChatIdRef.current = chat.id;

    if (wipe) {
      openingChatRef.current = true;
      initialLoadRef.current = true;
      publishIsAtBottom(true);
      followBottomRef.current = true;
      scrollIntentRef.current = 'initial';
      scrollAnchorRef.current = null;
      pendingPinToBottomRef.current = false;
      followBottomScrollCoalescerRef.current.cancel();
      programmaticScrollRef.current = false;
      composerFocusedRef.current = false;
      keyboardScrollTopLockRef.current = null;
      if (programmaticScrollClearTimerRef.current !== undefined) {
        window.clearTimeout(programmaticScrollClearTimerRef.current);
        programmaticScrollClearTimerRef.current = undefined;
      }
      setUnreadBelowCount(0);
      setMessages([]);
      setHistoryLoading(true);
      setLoadingOlder(false);
      olderLocalRef.current = [];
      hasOlderRemoteRef.current = false;
      loadingOlderRef.current = false;
      historyLoadGenRef.current += 1;
      setShowLists(false);
      setReplyTo(null);
      setHighlightId(null);
      setContextMenu(null);
      resetGestures();
    }
    // Wrap/epoch: re-decrypt in place — do not wipe (empty pane = white flash).
    void loadAndDecrypt();
  }, [chat.id, myGroupWrap, chat.groupKeyEpoch]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!syncTick) return;
    void loadAndDecrypt();
  }, [syncTick]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!listsAllowed) {
      onListUnreadChangeRef.current?.(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const unread = await checkListUnreadFromServer(chat.id);
      if (!cancelled) onListUnreadChangeRef.current?.(unread);
    })();
    return () => {
      cancelled = true;
    };
  }, [chat.id, listsAllowed]);

  useEffect(() => {
    if (!listsAllowed || !listEvent || listEvent.chatId !== chat.id) return;
    if (showListsRef.current) return;
    if (listEvent.actorUserId && listEvent.actorUserId === userId) return;
    if (
      !listEvent.actorUserId &&
      (listEvent.item?.updatedByUserId === userId ||
        listEvent.item?.createdByUserId === userId ||
        listEvent.list?.createdByUserId === userId)
    ) {
      return;
    }
    onListUnreadChangeRef.current?.(true);
  }, [listEvent, chat.id, userId, listsAllowed]);

  const openLists = useCallback(() => {
    setShowLists(true);
    onListUnreadChangeRef.current?.(false);
    void clearListUnread(chat.id);
  }, [chat.id]);

  useEffect(() => {
    // Prefer frame-coalesced batches (TASK-042); fall back to single-message prop.
    const batch: StoredMessage[] = incomingMessageBatch?.messages?.length
      ? incomingMessageBatch.messages
      : incomingMessage
        ? [incomingMessage]
        : [];
    const forChat = batch.filter((m) => m.chatId === chat.id);
    if (!forChat.length) return;

    const wasAtBottom = isAtBottomRef.current;
    const composerFocused = composerFocusedRef.current;
    const contextMenuOpen = contextMenuOpenRef.current;
    const allOwn = forChat.every((m) => m.senderId === userId);

    // TASK-022: own WS echo / merge is not a scroll source — only user Send arms pin.
    if (allOwn && !shouldFollowBottomForIncomingOwnMessage()) {
      updateMessages((prev) => {
        const { messages } = reconcileMessages(prev, forChat);
        return fillReplySnapshots(messages);
      });
      return;
    }

    let foreignInserted = 0;
    let insertedCount = 0;
    const plan = (() => {
      // Reconcile against the live snapshot so badge / scroll plan do not depend on
      // setState updater timing (React 19 may defer functional updaters).
      const { results } = reconcileMessages(messagesSnapshotRef.current, forChat);
      for (let i = 0; i < results.length; i++) {
        if (!results[i]!.inserted) continue;
        insertedCount += 1;
        if (forChat[i]!.senderId !== userId) foreignInserted += 1;
      }
      return planBurstIncomingScroll(
        wasAtBottom,
        insertedCount,
        composerFocused,
        contextMenuOpen,
      );
    })();

    // Default updateMessages branch clears pin; re-arm once we know the batch
    // actually inserted (ACK-only → no second scroll).
    updateMessages((prev) => {
      const { messages, results } = reconcileMessages(prev, forChat);
      const actualInserted = results.reduce((n, r) => n + (r.inserted ? 1 : 0), 0);
      if (plan.scrollAdjustments === 1 && actualInserted > 0) {
        // TASK-015: at-end burst keeps bottom anchoring; trailing pin is rAF-coalesced.
        const outcome = followBottomOutcome();
        followBottomRef.current = outcome.followBottom;
        pendingPinToBottomRef.current = outcome.pinToBottom;
        publishIsAtBottom(!outcome.showScrollDown);
      }
      return fillReplySnapshots(messages);
    });

    // MOB-005 / MOB-011 / MOB-055 / MOB-066: bump badge for foreign inserts that
    // did not pin (history reading OR preserve while typing/menu at former bottom).
    // Follow-bottom / at-end inserts intentionally leave the badge alone.
    if (
      shouldBumpUnreadBelowForIncoming({
        foreignInserted,
        scrollAdjustments: plan.scrollAdjustments,
      })
    ) {
      setUnreadBelowCount((n) => applyUnreadBelowDelta(n, foreignInserted));
    }
  }, [
    incomingMessageBatch,
    incomingMessage,
    chat.id,
    updateMessages,
    userId,
    publishIsAtBottom,
  ]);

  useEffect(() => {
    if (!deletedMessage || deletedMessage.chatId !== chat.id) return;
    if (deletedMessage.messageId === '*') {
      setContextMenu(null);
      setUnreadBelowCount(0);
      // Reload from storage — unsent outbox items may have been reinstated as pending.
      void (async () => {
        const fresh = dedupeStoredMessages(await hydrateStoredMessages(await getMessages(chat.id)));
        updateMessages(fresh.sort(compareMessages), { followBottom: true });
      })();
      return;
    }
    const removedId = deletedMessage.messageId;
    const opts = scrollOptsForDelete([removedId]);
    updateMessages((prev) => prev.filter((m) => m.id !== removedId), opts);
    // Selected / open context menu on the deleted row: close without scrolling.
    setContextMenu((cur) =>
      cur && cur.messageId === removedId ? null : cur,
    );
  }, [deletedMessage, chat.id, updateMessages, scrollOptsForDelete]);

  useEffect(() => {
    if (!headerMenuOpen) return;
    // iOS fires the same tap as a document click after open — defer listener.
    const onPointerDown = (e: PointerEvent) => {
      if (headerMenuRef.current?.contains(e.target as Node)) return;
      setHeaderMenuOpen(false);
    };
    const timer = window.setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown, true);
    }, 50);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [headerMenuOpen]);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const copyMessage = async (m: StoredMessage) => {
    closeContextMenu();
    const text = messageClipboardText(m);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      notify.success('Скопировано');
    } catch {
      notify.warning('Не удалось скопировать');
    }
  };

  const saveMessageMedia = async (m: StoredMessage) => {
    closeContextMenu();
    if (!m.imageUrl) {
      notify.warning('Медиа ещё не загружено');
      return;
    }
    try {
      const result = await saveChatImage({
        src: m.imageUrl,
        imageId: m.imageId,
        messageId: m.id,
      });
      if (result === 'saved') notify.success('Сохранено');
    } catch (e) {
      notify.error(e instanceof Error ? e.message : 'Не удалось сохранить');
    }
  };

  const removeMessage = async (m: StoredMessage) => {
    closeContextMenu();
    setDeleteTarget(null);
    // Deleting any photo in a tiled album removes the whole album.
    const targets =
      m.type === 'image' && m.albumId
        ? messages.filter((x) => x.type === 'image' && x.albumId === m.albumId)
        : [m];
    const goneIds = targets.map((t) => t.id);
    // Snapshot scroll policy before DOM nodes disappear (TASK-041).
    const opts = scrollOptsForDelete(goneIds);
    try {
      const { removeOutboxByTempMessageId } = await import('../lib/storage');
      for (const t of targets) {
        if (!t.pending) {
          await api.deleteMessage(chat.id, t.id);
        } else {
          await removeOutboxByTempMessageId(t.clientId || t.id);
        }
        await deleteMessageLocal(t.id, chat.id);
      }
      const gone = new Set(goneIds);
      updateMessages((prev) => prev.filter((x) => !gone.has(x.id)), opts);
      onMessagesChanged?.();
    } catch (e) {
      notify.error(e instanceof Error ? e.message : 'Не удалось удалить');
    }
  };

  const requestDeleteMessage = (m: StoredMessage) => {
    closeContextMenu();
    setDeleteTarget(m);
  };

  const openContextMenu = useCallback((m: StoredMessage, bubbleEl: HTMLElement) => {
    // Drop any native selection that started during the hold (iOS callout race).
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* ignore */
    }
    const rect = bubbleEl.getBoundingClientRect();
    setContextMenu({
      messageId: m.id,
      clientId: m.clientId,
      anchorRect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
    });
  }, []);
  openContextMenuForGestureRef.current = openContextMenu;

  const contextMenuMessage = contextMenu
    ? messages.find((m) =>
        sameMessageIdentity(m, {
          id: contextMenu.messageId,
          clientId: contextMenu.clientId,
        }),
      ) ?? null
    : null;

  const deleteConfirmCopy = (() => {
    if (!deleteTarget) return { title: '', body: '' };
    if (deleteTarget.type === 'image' && deleteTarget.albumId) {
      const n = messages.filter(
        (x) => x.type === 'image' && x.albumId === deleteTarget.albumId,
      ).length;
      if (n > 1) {
        return {
          title: 'Удалить альбом?',
          body: `Будет удалено ${n} фото у всех участников чата.`,
        };
      }
    }
    if (deleteTarget.type === 'video') {
      return {
        title: 'Удалить видео?',
        body: 'Видео будет удалено у всех участников чата.',
      };
    }
    if (deleteTarget.type === 'image') {
      return {
        title: 'Удалить фото?',
        body: 'Фото будет удалено у всех участников чата.',
      };
    }
    return {
      title: 'Удалить сообщение?',
      body: 'Сообщение будет удалено у всех участников чата.',
    };
  })();

  const refreshFromStorage = useCallback(async () => {
    const fresh = dedupeStoredMessages(await getMessages(chat.id)).sort(compareMessages);
    // Soft refresh must not re-hydrate / remount the entire history (jank + blob churn).
    updateMessages((prev) => {
      if (!prev.length) {
        const { visible, older } = sliceRecentMessages(fresh);
        olderLocalRef.current = older;
        return visible;
      }
      const byId = new Map(fresh.map((m) => [m.id, m]));
      const byClient = new Map(
        fresh.filter((m) => m.clientId).map((m) => [m.clientId as string, m]),
      );
      return prev.map((m) => {
        const next =
          byId.get(m.id) ||
          (m.clientId ? byClient.get(m.clientId) : undefined) ||
          byClient.get(m.id);
        if (!next) return m;
        return {
          ...next,
          // Keep hydrated object URLs so <img> does not remount/reload.
          imageUrl: m.imageUrl || next.imageUrl,
          posterUrl: m.posterUrl || next.posterUrl,
        };
      });
    });
  }, [chat.id, updateMessages]);

  const jumpToLatest = useCallback(() => {
    // Explicit ↓: only reset path besides the user manually reaching the end.
    setUnreadBelowCount((n) => applyUnreadBelowCount(n, 'reset'));
    followBottomRef.current = true;
    scrollIntentRef.current = 'jump-to-latest';
    scrollToEnd();
  }, [scrollToEnd]);

  useEffect(() => {
    // Soft refresh only — App already forces full history sync on resume/reconnect.
    // Full loadAndDecrypt on every focus was racing syncTick and yanking scroll.
    const softRefresh = () => {
      if (!document.hidden) void refreshFromStorage();
    };
    const onOnline = () => {
      if (!document.hidden) void loadAndDecrypt();
    };
    const onFlushed = () => {
      // Prefer storage reload: pending→real id already applied by outbox replace.
      void refreshFromStorage();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', softRefresh);
    window.addEventListener(OUTBOX_FLUSHED_EVENT, onFlushed);
    window.addEventListener(OUTBOX_FAILED_EVENT, onFlushed);
    document.addEventListener('visibilitychange', softRefresh);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', softRefresh);
      window.removeEventListener(OUTBOX_FLUSHED_EVENT, onFlushed);
      window.removeEventListener(OUTBOX_FAILED_EVENT, onFlushed);
      document.removeEventListener('visibilitychange', softRefresh);
    };
  }, [loadAndDecrypt, refreshFromStorage]);

  useLayoutEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    if (openingChatRef.current || initialLoadRef.current) {
      pendingPinToBottomRef.current = false;
      // TASK-043: pin only while follow is still armed; mid-load scroll-up wins.
      if (initialLoadScrollPolicy(followBottomRef.current) === 'follow-bottom') {
        scrollToEnd();
        scrollAnchorRef.current = null;
        layoutWasAtBottomRef.current = true;
        liveVisualAnchorRef.current = captureVisualScrollAnchor(el);
      } else if (scrollAnchorRef.current) {
        const anchor = scrollAnchorRef.current;
        beginProgrammaticScroll();
        applyVisualScrollAnchor(el, anchor);
        scrollAnchorRef.current = null;
        const measured = measureChatViewport(el);
        publishIsAtBottom(measured.isAtBottom);
        layoutWasAtBottomRef.current = measured.isAtBottom;
        liveVisualAnchorRef.current = captureVisualScrollAnchor(el);
        if (scrollIntentRef.current === 'history-anchor') {
          scrollIntentRef.current = 'none';
        }
      } else {
        const measured = measureChatViewport(el);
        publishIsAtBottom(measured.isAtBottom);
        layoutWasAtBottomRef.current = measured.isAtBottom;
        liveVisualAnchorRef.current = captureVisualScrollAnchor(el);
      }
      if (openingChatRef.current && messages.length > 0) {
        openingChatRef.current = false;
      }
      return;
    }

    // Explicit pin from updateMessages (follow / own-message / opening).
    // Use the pre-commit arming flag — after append, measureChatViewport often
    // reports !atBottom even when the user *was* stuck to the end.
    if (pendingPinToBottomRef.current) {
      pendingPinToBottomRef.current = false;
      // Sync jump before paint (no FAB flash); trailing rAF is coalesced for bursts.
      scrollToEnd();
      scrollAnchorRef.current = null;
      layoutWasAtBottomRef.current = true;
      liveVisualAnchorRef.current = captureVisualScrollAnchor(el);
      if (isBottomTargetingIntent(scrollIntentRef.current)) {
        scrollIntentRef.current = 'none';
      }
      return;
    }

    // Opt-in history-anchor only (never auto-armed by a bare messages change).
    // TASK-019: restore message-id Y; scrollHeight compensation is the fallback.
    if (scrollAnchorRef.current) {
      const anchor = scrollAnchorRef.current;
      beginProgrammaticScroll();
      applyVisualScrollAnchor(el, anchor);
      scrollAnchorRef.current = null;
      const measured = measureChatViewport(el);
      publishIsAtBottom(measured.isAtBottom);
      layoutWasAtBottomRef.current = measured.isAtBottom;
      liveVisualAnchorRef.current = captureVisualScrollAnchor(el);
      if (scrollIntentRef.current === 'history-anchor') {
        scrollIntentRef.current = 'none';
      }
      return;
    }

    // Messages changed without a scroll command — leave scrollTop untouched.
    const measured = measureChatViewport(el);
    publishIsAtBottom(measured.isAtBottom);
    layoutWasAtBottomRef.current = measured.isAtBottom;
    liveVisualAnchorRef.current = captureVisualScrollAnchor(el);
  }, [messages, scrollToEnd, beginProgrammaticScroll, publishIsAtBottom]);

  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const coalescer = createRafCoalescer();
    let lastScrollHeight = el.scrollHeight;
    let lastClientHeight = el.clientHeight;
    // Seed layout facts / visual anchor before the first resize/load pass.
    layoutWasAtBottomRef.current = measureChatViewport(el).isAtBottom;
    liveVisualAnchorRef.current = captureVisualScrollAnchor(el);

    const refreshLayoutSnapshot = () => {
      const measured = measureChatViewport(el);
      publishIsAtBottom(measured.isAtBottom);
      layoutWasAtBottomRef.current = measured.isAtBottom;
      liveVisualAnchorRef.current = captureVisualScrollAnchor(el);
      lastScrollHeight = el.scrollHeight;
      lastClientHeight = el.clientHeight;
    };

    const onMediaLayout = () => {
      coalescer.schedule(() => {
        // TASK-043: initial-load media growth pins only while follow is armed.
        if (
          (openingChatRef.current || initialLoadRef.current) &&
          initialLoadScrollPolicy(followBottomRef.current) === 'follow-bottom'
        ) {
          lastScrollHeight = el.scrollHeight;
          lastClientHeight = el.clientHeight;
          scrollToEnd();
          layoutWasAtBottomRef.current = true;
          liveVisualAnchorRef.current = captureVisualScrollAnchor(el);
          return;
        }
        const contentGrew = el.scrollHeight > lastScrollHeight;
        const viewportResized = el.clientHeight !== lastClientHeight;
        const wasAtBottom = layoutWasAtBottomRef.current;
        const preAnchor = liveVisualAnchorRef.current;
        lastScrollHeight = el.scrollHeight;
        lastClientHeight = el.clientHeight;
        const keyboardShellActive = isVisualViewportShellActive();
        // Content grew (new bubble / late image). Pin only when the user was
        // actually at the end before growth (TASK-020) — ResizeObserver is not
        // a hidden scrollToBottom. Temporary post-growth !atBottom is fine when
        // wasAtBottom was true; only the user scroll handler clears followBottom.
        // TASK-016: while composing, content growth must not yank.
        // TASK-017: viewport-only resize (textarea autoresize) must not pin —
        // only remeasure so ↓ reflects the new message-list height.
        // TASK-018: visualViewport / IME shell open↔close is never pin permission.
        if (
          shouldFollowBottomOnMediaLayout({
            followBottom: followBottomRef.current,
            composerFocused: composerFocusedRef.current,
            contentGrew,
            viewportResized,
            keyboardShellActive,
            wasAtBottom,
            contextMenuOpen: contextMenuOpenRef.current,
          })
        ) {
          scheduleFollowBottomScroll();
          layoutWasAtBottomRef.current = true;
          return;
        }

        if (keyboardShellActive) {
          // TASK-018: IME / visualViewport shell — never pin; restore logical scroll.
          const sync = visualViewportResizeSync();
          if (
            sync.preserveScrollTop &&
            keyboardScrollTopLockRef.current !== null &&
            !programmaticScrollRef.current &&
            el.scrollTop !== keyboardScrollTopLockRef.current
          ) {
            beginProgrammaticScroll();
            el.scrollTop = keyboardScrollTopLockRef.current;
          }
          if (sync.remeasureIsAtBottom) {
            publishIsAtBottom(measureChatViewport(el).isAtBottom);
          }
          return;
        }

        if (viewportResized && !contentGrew) {
          // TASK-017: composer autoresize / chrome — remeasure only.
          const sync = composerResizeSync();
          if (sync.remeasureIsAtBottom) {
            publishIsAtBottom(measureChatViewport(el).isAtBottom);
          }
          return;
        }

        // TASK-021: late media / reply / dynamic height above the viewport.
        // Reading history → restore the pre-change visual anchor; never pin.
        if (contentGrew && !wasAtBottom && preAnchor) {
          beginProgrammaticScroll();
          applyVisualScrollAnchor(el, preAnchor);
        }
        refreshLayoutSnapshot();
      });
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onMediaLayout) : null;
    messagesResizeObserverRef.current = ro;
    // Observe the scroller (viewport size) and each row (images, reply blocks,
    // dynamic text) so late height changes fire the same anchoring path.
    ro?.observe(el);
    for (const child of el.children) {
      ro?.observe(child);
    }
    el.addEventListener('load', onMediaLayout, true);
    return () => {
      coalescer.cancel();
      messagesResizeObserverRef.current = null;
      ro?.disconnect();
      el.removeEventListener('load', onMediaLayout, true);
    };
  }, [chat.id, scrollToEnd, scheduleFollowBottomScroll, publishIsAtBottom, beginProgrammaticScroll]);

  // Keep ResizeObserver coverage on newly mounted message rows without remounting
  // the observer (history prepend / incoming must not reset scrollHeight baselines).
  useLayoutEffect(() => {
    const el = messagesRef.current;
    const ro = messagesResizeObserverRef.current;
    if (!el || !ro) return;
    for (const child of el.children) {
      ro.observe(child);
    }
  }, [messages]);

  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    /**
     * User scroll handler (TASK-011).
     * Observe only: measure → isAtBottomRef → UI/follow as needed.
     * Never call scrollToEnd / mutate scrollTop from here (no onScroll → scrollToBottom).
     */
    const onUserScroll = () => {
      const measurement = measureChatViewport(el);
      publishIsAtBottom(measurement.isAtBottom);
      layoutWasAtBottomRef.current = measurement.isAtBottom;
      // Keep a fresh visual anchor so late media above the viewport can restore Y.
      liveVisualAnchorRef.current = captureVisualScrollAnchor(el);

      // App-driven scrollTop/scrollIntoView: keep the fact in sync, leave follow alone.
      if (programmaticScrollRef.current) return;

      const sync = syncFromUserScroll(measurement);
      // Manual scroll owns follow permission — user left or returned to the bottom.
      // TASK-043: also during open/initial load so mid-fetch scroll-up cancels pin.
      followBottomRef.current = sync.followBottom;
      if (!sync.followBottom) {
        pendingPinToBottomRef.current = false;
        followBottomScrollCoalescerRef.current.cancel();
        if (scrollIntentRef.current === 'initial') {
          scrollIntentRef.current = 'none';
        }
      }
      // Composer focus locks logical scroll against IME; user gestures refresh it.
      if (composerFocusedRef.current || keyboardScrollTopLockRef.current !== null) {
        keyboardScrollTopLockRef.current = el.scrollTop;
      }
      if (!sync.resetUnreadBelow) return;

      if (scrollIntentRef.current !== 'reply-target') {
        scrollIntentRef.current = 'none';
      }
      // User manually reached the end — the only scroll-driven reset path.
      // Focus/blur/resize/context-menu/storage must not clear unreadBelowCount.
      setUnreadBelowCount((n) => applyUnreadBelowCount(n, 'reset'));
    };
    const onScrollMaybeLoadOlder = () => {
      onUserScroll();
      if (programmaticScrollRef.current) return;
      if (el.scrollTop > 240) return;
      if (!olderLocalRef.current.length && !hasOlderRemoteRef.current) return;
      void loadOlderMessages();
    };
    el.addEventListener('scroll', onScrollMaybeLoadOlder, { passive: true });
    return () => el.removeEventListener('scroll', onScrollMaybeLoadOlder);
  }, [chat.id, publishIsAtBottom, loadOlderMessages]);

  const stopTyping = useCallback(() => {
    if (typingIdleRef.current !== undefined) {
      window.clearTimeout(typingIdleRef.current);
      typingIdleRef.current = undefined;
    }
    if (typingActiveRef.current) {
      typingActiveRef.current = false;
      onTypingChange?.(false);
    }
  }, [onTypingChange]);

  const bumpTyping = useCallback(() => {
    if (!onTypingChange) return;
    if (!typingActiveRef.current) {
      typingActiveRef.current = true;
      onTypingChange(true);
    }
    if (typingIdleRef.current !== undefined) window.clearTimeout(typingIdleRef.current);
    typingIdleRef.current = window.setTimeout(() => {
      typingActiveRef.current = false;
      onTypingChange(false);
      typingIdleRef.current = undefined;
    }, 2500);
  }, [onTypingChange]);

  useEffect(() => () => stopTyping(), [stopTyping, chat.id]);

  const peer = chat.type === 'direct' ? chat.members.find((m) => m.id !== userId) : undefined;
  const typingMember = typingUserId
    ? chat.members.find((m) => m.id === typingUserId)
    : undefined;
  const statusLabel = (() => {
    if (peerTyping && typingMember) {
      return chat.type === 'group'
        ? `${typingMember.username} печатает…`
        : 'печатает…';
    }
    if (chat.type === 'direct') {
      return peerStatusText({
        online: peer?.online,
        lastSeenAt: peer?.lastSeenAt,
        typing: false,
      });
    }
    return null;
  })();

  const focusCompose = useCallback(() => {
    const el = composeRef.current;
    if (!el) return;
    // Keep the soft keyboard open after send (button must not steal focus).
    requestAnimationFrame(() => {
      el.focus({ preventScroll: true });
    });
  }, []);

  const beginReply = useCallback(
    (m: StoredMessage) => {
      if (!canReplyToMessage(m)) return;
      closeContextMenu();
      setReplyTo(buildReplySnapshot(m));
      focusCompose();
      try {
        navigator.vibrate?.(12);
      } catch {
        /* ignore */
      }
    },
    [focusCompose, closeContextMenu],
  );
  beginReplyForGestureRef.current = beginReply;

  const cancelReply = useCallback(() => {
    setReplyTo(null);
  }, []);

  const highlightReplyTarget = useCallback((messageId: string) => {
    setHighlightId(messageId);
    window.setTimeout(() => {
      setHighlightId((cur) => (cur === messageId ? null : cur));
      if (scrollIntentRef.current === 'reply-target') {
        scrollIntentRef.current = 'none';
      }
    }, REPLY_TARGET_HIGHLIGHT_MS);
  }, []);

  const scrollToReplyTargetEl = useCallback(
    (el: HTMLElement, messageId: string) => {
      followBottomRef.current = false;
      scrollIntentRef.current = 'reply-target';
      // Smooth scrollIntoView emits many scroll events — keep them non-user.
      const reduceMotion =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      beginProgrammaticScroll(reduceMotion ? 80 : 800);
      el.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'center',
      });
      highlightReplyTarget(messageId);
    },
    [beginProgrammaticScroll, highlightReplyTarget],
  );

  /**
   * Jump to the exact reply parent by id (TASK-037).
   * If the target is not loaded yet, refresh history, then locate the same id —
   * never approximate by timestamp.
   */
  const scrollToReplied = useCallback(
    async (messageId: string) => {
      const root = messagesRef.current;
      if (!root || !messageId) return;

      const tryScroll = (list: StoredMessage[]): boolean => {
        const el = findReplyTargetElement(root, messageId, list);
        if (!el) return false;
        // Album members share the first tile's wrap — highlight that wrap's id.
        const wrapId = el.getAttribute('data-message-id') || messageId;
        scrollToReplyTargetEl(el, wrapId);
        return true;
      };

      if (tryScroll(messagesSnapshotRef.current)) return;

      // Target missing from the current window — load until the id is mounted.
      if (!findMessageById(messagesSnapshotRef.current, messageId)) {
        try {
          const ok = await ensureMessageLoaded(messageId);
          if (!ok) return;
        } catch {
          return;
        }
      }

      // Wait a frame so React can commit newly loaded rows.
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });

      const list = messagesSnapshotRef.current;
      if (!findMessageById(list, messageId)) {
        // Parent no longer exists / inaccessible — do not jump elsewhere.
        return;
      }
      tryScroll(list);
    },
    [ensureMessageLoaded, scrollToReplyTargetEl],
  );

  const sendText = async () => {
    if (!text.trim() || sending) return;
    stopTyping();
    setSending(true);
    const plain = text.trim();
    const clientId = crypto.randomUUID();
    const tempId = `pending-${clientId}`;
    const reply = replyTo;
    let queued = false;
    try {
      const { ciphertext, iv } = await encryptChatMessage(plain, chat, userId, privateKeyB64);

      const pending: StoredMessage = {
        id: tempId,
        chatId: chat.id,
        senderId: userId,
        senderName: usernames.get(userId) || 'Я',
        text: plain,
        type: 'text',
        ...(reply
          ? {
              replyToMessageId: reply.replyToMessageId,
              replyToSenderId: reply.replyToSenderId,
              replyToSenderName: reply.replyToSenderName,
              replyToPreview: reply.replyToPreview,
              replyToType: reply.replyToType,
            }
          : {}),
        clientId,
        createdAt: Date.now(),
        pending: true,
      };
      await saveMessage(pending);
      // TASK-022: user Send is the sole own-message scroll source.
      updateMessages(
        (prev) => upsertMessageInList(prev, pending).next,
        shouldArmOwnMessageScroll('user-send')
          ? { followBottom: true, scrollIntent: 'own-message' }
          : undefined,
      );
      setText('');
      setReplyTo(null);
      focusCompose();
      onMessagesChanged?.();
      queued = true;

      // Deliver immediately — do not depend on background flush / photo mutex.
      // Outbox tempMessageId == clientId (stable across retries).
      const msg = await sendTextMessage(
        chat.id,
        clientId,
        ciphertext,
        iv,
        plain,
        undefined,
        reply
          ? {
              replyToMessageId: reply.replyToMessageId,
              replyToSenderId: reply.replyToSenderId,
              replyToSenderName: reply.replyToSenderName,
              replyToPreview: reply.replyToPreview,
              replyToType: reply.replyToType,
            }
          : undefined,
      );
      // Same canonical upsert as WebSocket: pending (clientId=A) becomes
      // id=serverId, clientId=A — one entity, bubble count unchanged.
      // Idempotent if WS already confirmed the row before HTTP ACK.
      const confirmed: StoredMessage = {
        id: msg.id,
        chatId: msg.chatId,
        senderId: msg.senderId,
        senderName: usernames.get(userId) || 'Я',
        text: plain,
        type: 'text',
        ...(reply
          ? {
              replyToMessageId: msg.replyToMessageId ?? reply.replyToMessageId,
              replyToSenderId: reply.replyToSenderId,
              replyToSenderName: reply.replyToSenderName,
              replyToPreview: reply.replyToPreview,
              replyToType: reply.replyToType,
            }
          : {}),
        clientId: msg.clientId || clientId,
        sequence: msg.sequence,
        createdAt: msg.createdAt,
        pending: false,
      };
      const merged = await upsertStoredMessage(confirmed);
      // TASK-022: HTTP ACK must not re-arm own-message scroll.
      updateMessages((prev) => upsertMessageInList(prev, merged).next);
      onMessagesChanged?.();
    } catch (err) {
      if (!queued) {
        notify.error(
          /нет ключа группы/i.test(err instanceof Error ? err.message : '')
            ? 'Нет ключа чата. Откройте bootstrap-ссылку ещё раз или попросите участника открыть «Общий».'
            : 'Не удалось подготовить сообщение.',
        );
        return;
      }
      // Still in outbox — background flush may retry. Show why the clock is stuck.
      const message = err instanceof Error ? err.message : 'Не удалось отправить';
      if (isForbiddenError(err)) {
        try {
          const rows = await getMessages(chat.id);
          const row = rows.find((m) => m.id === tempId || m.clientId === clientId);
          if (row) {
            await saveMessage({
              ...row,
              pending: false,
              failed: true,
              error: 'Нет доступа к чату. Обновите список чатов.',
            });
          }
        } catch {
          /* ignore */
        }
        void refreshFromStorage();
        notify.error('Нет доступа к чату. Обновите список чатов.');
      } else if (isOfflineError(err) || !isOnline()) {
        notify.info('Сообщение будет отправлено при появлении сети');
        void flushOutbox({ force: true, lane: 'message' });
      } else {
        notify.error(message);
        void flushOutbox({ force: true, lane: 'message' });
      }
    } finally {
      setSending(false);
      focusCompose();
    }
  };

  const MAX_IMAGES_PER_PICK = 30;

  const queueImage = async (
    file: File,
    createdAt: number,
    albumId?: string,
    reply?: ReplySnapshot | null,
  ): Promise<boolean> => {
    // Compress client-side (resize + re-encode) before queueing; fall back to the
    // original bytes if the browser cannot decode this image. No hard size cap —
    // IndexedDB failures are handled below with a storage-specific message.
    let processed: Blob;
    try {
      const compressed = await compressChatImage(file);
      processed = compressed.blob;
    } catch {
      processed = await prepareChatImage(file);
    }
    const mimeType = processed.type || 'image/jpeg';
    const uploadBytes = await processed.arrayBuffer();
    if (!uploadBytes.byteLength) {
      throw new Error('Пустой файл');
    }

    const clientId = crypto.randomUUID();
    const tempId = `pending-${clientId}`;
    // Photos are NOT E2E-encrypted: bytes go to object storage as-is, and the
    // small message envelope is plaintext too (iv=plain).
    const msgPlain = JSON.stringify({ name: file.name || 'photo' });

    try {
      await enqueueImageOutbox(
        chat.id,
        clientId,
        uploadBytes,
        mimeType,
        msgPlain,
        PLAIN_IV,
        // Same bytes as upload — outbox stores a single Blob copy.
        new ArrayBuffer(0),
        mimeType,
        albumId,
        reply
          ? {
              replyToMessageId: reply.replyToMessageId,
              replyToSenderId: reply.replyToSenderId,
              replyToSenderName: reply.replyToSenderName,
              replyToPreview: reply.replyToPreview,
              replyToType: reply.replyToType,
            }
          : undefined,
      );
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e ?? '');
      if (/indexed database/i.test(raw)) {
        throw new Error('Не удалось сохранить фото на устройстве. Освободите место или перезапустите приложение.');
      }
      throw e;
    }

    const pending: StoredMessage = {
      id: tempId,
      chatId: chat.id,
      senderId: userId,
      senderName: usernames.get(userId) || 'Я',
      text: '📷 Изображение',
      type: 'image',
      albumId,
      ...(reply
        ? {
            replyToMessageId: reply.replyToMessageId,
            replyToSenderId: reply.replyToSenderId,
            replyToSenderName: reply.replyToSenderName,
            replyToPreview: reply.replyToPreview,
            replyToType: reply.replyToType,
          }
        : {}),
      clientId,
      createdAt,
      pending: true,
    };
    // One local preview key is enough for the pending bubble.
    await persistLocalPreview(tempId, uploadBytes.slice(0), mimeType);
    await saveMessage(pending);
    const [hydratedPending] = await hydrateStoredMessages([pending]);
    // TASK-022: user Send (photo queue) is the sole own-message scroll source.
    updateMessages(
      (prev) => upsertMessageInList(prev, hydratedPending).next,
      shouldArmOwnMessageScroll('user-send')
        ? { followBottom: true, scrollIntent: 'own-message' }
        : undefined,
    );
    onMessagesChanged?.();
    return true;
  };

  const queueVideo = async (
    file: File,
    createdAt: number,
    reply?: ReplySnapshot | null,
  ): Promise<boolean> => {
    if (file.size > MAX_VIDEO_BYTES) {
      notify.warning('Видео слишком большое (макс. 100 МБ)');
      return false;
    }
    const mimeType = file.type || 'video/mp4';
    const previewData = await file.arrayBuffer();
    if (!previewData.byteLength) {
      notify.error('Пустой видеофайл');
      return false;
    }

    let posterBytes: ArrayBuffer | null = null;
    let posterMime = 'image/jpeg';
    let posterUrl: string | undefined;
    try {
      const poster = await captureVideoPoster(file);
      posterBytes = poster.data;
      posterMime = poster.mimeType;
      posterUrl = URL.createObjectURL(new Blob([posterBytes], { type: posterMime }));
    } catch {
      /* bubble will fall back to video frame */
    }

    const clientId = crypto.randomUUID();
    const tempId = `pending-${clientId}`;
    const msgPlain = JSON.stringify({ name: file.name || 'video' });
    const uploadBytes = previewData.slice(0);
    const videoPreviewBytes = previewData.slice(0);

    await enqueueVideoOutbox(
      chat.id,
      clientId,
      uploadBytes,
      mimeType,
      msgPlain,
      PLAIN_IV,
      posterBytes ?? videoPreviewBytes.slice(0),
      posterBytes ? posterMime : mimeType,
      reply
        ? {
            replyToMessageId: reply.replyToMessageId,
            replyToSenderId: reply.replyToSenderId,
            replyToSenderName: reply.replyToSenderName,
            replyToPreview: reply.replyToPreview,
            replyToType: reply.replyToType,
          }
        : undefined,
    );

    const videoUrl = URL.createObjectURL(new Blob([videoPreviewBytes], { type: mimeType }));
    const pending: StoredMessage = {
      id: tempId,
      chatId: chat.id,
      senderId: userId,
      senderName: usernames.get(userId) || 'Я',
      text: '🎬 Видео',
      type: 'video',
      imageUrl: videoUrl,
      posterUrl,
      ...(reply
        ? {
            replyToMessageId: reply.replyToMessageId,
            replyToSenderId: reply.replyToSenderId,
            replyToSenderName: reply.replyToSenderName,
            replyToPreview: reply.replyToPreview,
            replyToType: reply.replyToType,
          }
        : {}),
      clientId,
      createdAt,
      pending: true,
    };
    // Keep full video for pending playback after reload; poster for the bubble thumb.
    await persistLocalPreview(tempId, videoPreviewBytes, mimeType);
    await persistLocalPreview(clientId, videoPreviewBytes.slice(0), mimeType);
    if (posterBytes) {
      await persistVideoPoster(tempId, posterBytes, posterMime);
      await persistVideoPoster(clientId, posterBytes.slice(0), posterMime);
    }
    await saveMessage(pending);
    // TASK-022: user Send (video queue) is the sole own-message scroll source.
    updateMessages(
      (prev) => upsertMessageInList(prev, pending).next,
      shouldArmOwnMessageScroll('user-send')
        ? { followBottom: true, scrollIntent: 'own-message' }
        : undefined,
    );
    onMessagesChanged?.();
    return true;
  };

  const sendImages = async (files: FileList | File[]) => {
    const picked = Array.from(files).filter((f) => f && f.size > 0);
    if (!picked.length || sending) return;
    if (picked.length > MAX_IMAGES_PER_PICK) {
      notify.warning(`Можно отправить до ${MAX_IMAGES_PER_PICK} фото за раз`);
    }
    setSending(true);
    let queued = 0;
    const base = Date.now();
    try {
      // Snapshot bytes BEFORE the file input is cleared — clearing <input type="file">
      // invalidates unread File blobs on iOS/Android WebView, so only the first photo
      // would upload and the rest stay forever pending.
      const list = picked.slice(0, MAX_IMAGES_PER_PICK);
      const snapshots: File[] = [];
      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        try {
          const buf = await file.arrayBuffer();
          if (!buf.byteLength) {
            throw new Error('Пустой файл');
          }
          snapshots.push(
            new File([buf], file.name || `photo-${i + 1}.jpg`, {
              type: file.type || 'application/octet-stream',
              lastModified: file.lastModified,
            }),
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Неизвестная ошибка';
          notify.error(`Не удалось прочитать «${file.name || 'фото'}»: ${msg}`);
        }
      }

      // Several photos picked at once become one tiled album (shared media-group id).
      const albumId = snapshots.length > 1 ? crypto.randomUUID() : undefined;
      const reply = replyTo;
      for (let i = 0; i < snapshots.length; i++) {
        try {
          // Attach the quote to the first photo only (Telegram album reply).
          await queueImage(snapshots[i], base + i, albumId, i === 0 ? reply : null);
          queued++;
          if (i === 0 && reply) setReplyTo(null);
          // Kick the FIFO send queue immediately so photo 1 uploads while
          // the rest are still being prepared.
          void flushOutbox({ force: true });
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Неизвестная ошибка';
          const label = snapshots[i].name || 'фото';
          notify.error(`Не удалось отправить «${label}»: ${msg}`);
        }
      }
    } finally {
      setSending(false);
    }

    if (queued === 0) return;
    void flushOutbox({ force: true }).then((sent) => {
      if (sent > 0) {
        void refreshFromStorage();
      } else if (!isOnline()) {
        notify.info(
          queued > 1
            ? 'Фото будут отправлены при появлении сети'
            : 'Фото будет отправлено при появлении сети',
        );
      }
    });
  };
  sendImagesRef.current = sendImages;

  const sendVideos = async (files: FileList | File[]) => {
    const picked = Array.from(files).filter((f) => f && f.size > 0);
    if (!picked.length || sending) return;
    if (picked.length > MAX_VIDEOS_PER_PICK) {
      notify.warning(`Можно отправить до ${MAX_VIDEOS_PER_PICK} видео за раз`);
    }
    setSending(true);
    let queued = 0;
    const base = Date.now();
    try {
      const list = picked.slice(0, MAX_VIDEOS_PER_PICK);
      const snapshots: File[] = [];
      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        try {
          const buf = await file.arrayBuffer();
          if (!buf.byteLength) throw new Error('Пустой файл');
          snapshots.push(
            new File([buf], file.name || `video-${i + 1}.mp4`, {
              type: file.type || 'video/mp4',
              lastModified: file.lastModified,
            }),
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Неизвестная ошибка';
          notify.error(`Не удалось прочитать «${file.name || 'видео'}»: ${msg}`);
        }
      }

      const reply = replyTo;
      for (let i = 0; i < snapshots.length; i++) {
        try {
          const ok = await queueVideo(snapshots[i], base + i, i === 0 ? reply : null);
          if (!ok) continue;
          queued++;
          if (i === 0 && reply) setReplyTo(null);
          void flushOutbox({ force: true });
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Неизвестная ошибка';
          notify.error(`Не удалось отправить «${snapshots[i].name || 'видео'}»: ${msg}`);
        }
      }
    } finally {
      setSending(false);
    }

    if (queued === 0) return;
    void flushOutbox({ force: true }).then((sent) => {
      if (sent > 0) {
        void refreshFromStorage();
      } else if (!isOnline()) {
        notify.info(
          queued > 1
            ? 'Видео будут отправлены при появлении сети'
            : 'Видео будет отправлено при появлении сети',
        );
      }
    });
  };

  const sendMedia = async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f && f.size > 0);
    if (!list.length) return;
    const videos = list.filter(isVideoFile);
    const images = list.filter((f) => !isVideoFile(f));
    if (images.length) await sendImages(images);
    if (videos.length) await sendVideos(videos);
  };
  sendMediaRef.current = sendMedia;

  // Web Share Target: auto-send once when parent hands off shared photos/videos.
  useEffect(() => {
    if (!sharedFiles?.length) return;
    const files = sharedFiles;
    onSharedFilesConsumed?.();
    void sendMediaRef.current(files);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot handoff
  }, [sharedFiles]);

  return (
    <div className="chat-view">
      <header className="chat-view-header">
        {onBack && (
          <button type="button" className="tg-back-btn" onClick={onBack} aria-label="Назад">
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden><path fill="currentColor" d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
          </button>
        )}
        {chat.type === 'group' ? (
          <ChatAvatar
            chatId={chat.id}
            name={chat.displayName}
            isSystem={chat.isSystem}
            hasAvatar={chat.hasAvatar}
            avatarUpdatedAt={chat.avatarUpdatedAt}
            avatarUrl={chat.avatarUrl}
            className="chat-avatar"
          />
        ) : peer ? (
          <UserAvatar
            userId={peer.id}
            name={chat.displayName}
            hasAvatar={peer.hasAvatar}
            avatarUpdatedAt={peer.avatarUpdatedAt}
            avatarUrl={peer.avatarUrl}
            className="chat-avatar"
          />
        ) : (
          <span className="chat-avatar" aria-hidden>
            {chatInitials(chat.displayName)}
          </span>
        )}
        <div className="chat-view-header-info">
          <h2>{chat.displayName}</h2>
          {chat.type === 'group' ? (
            <>
              {statusLabel ? (
                <span className="chat-peer-status typing">{statusLabel}</span>
              ) : (
                <button type="button" className="members-count-btn" onClick={() => setShowMembers(true)}>
                  {chat.members.length} участников
                </button>
              )}
            </>
          ) : (
            <span className={`chat-peer-status ${peerTyping ? 'typing' : peer?.online ? 'online' : ''}`}>
              {statusLabel}
            </span>
          )}
        </div>
        {chat.type === 'direct' && onStartVideoCall && (
          <button
            type="button"
            className="icon-btn chat-call-btn"
            title="Видеозвонок"
            aria-label="Видеозвонок"
            onClick={onStartVideoCall}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
              <path
                fill="currentColor"
                d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"
              />
            </svg>
          </button>
        )}
        {listsAllowed && (
          <button
            type="button"
            className={`icon-btn chat-lists-btn${listUnread ? ' has-list-unread' : ''}`}
            title="Списки"
            aria-label={listUnread ? 'Списки, есть изменения' : 'Списки'}
            onClick={openLists}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
              <path
                fill="currentColor"
                d="M3 5h2v2H3V5zm4 0h14v2H7V5zM3 11h2v2H3v-2zm4 0h14v2H7v-2zM3 17h2v2H3v-2zm4 0h14v2H7v-2z"
              />
            </svg>
            {listUnread && <span className="chat-lists-unread-dot" aria-hidden />}
          </button>
        )}
        {(canClearChat && onClearChat) || (canDeleteChat && onDeleteChat) ? (
          <div className="chat-header-menu-wrap" ref={headerMenuRef}>
            <button
              type="button"
              className="icon-btn chat-more-btn"
              title="Ещё"
              aria-label="Ещё"
              aria-expanded={headerMenuOpen}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setHeaderMenuOpen((v) => !v);
              }}
            >
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
                <circle cx="5" cy="12" r="1.8" fill="currentColor" />
                <circle cx="12" cy="12" r="1.8" fill="currentColor" />
                <circle cx="19" cy="12" r="1.8" fill="currentColor" />
              </svg>
            </button>
            {headerMenuOpen && (
              <div className="chat-header-menu" role="menu">
                {canClearChat && onClearChat && (
                  <button
                    type="button"
                    className="danger"
                    role="menuitem"
                    onClick={() => {
                      setHeaderMenuOpen(false);
                      onClearChat();
                    }}
                  >
                    Очистить чат
                  </button>
                )}
                {canDeleteChat && onDeleteChat && (
                  <button
                    type="button"
                    className="danger"
                    role="menuitem"
                    onClick={() => {
                      setHeaderMenuOpen(false);
                      onDeleteChat();
                    }}
                  >
                    Удалить чат
                  </button>
                )}
              </div>
            )}
          </div>
        ) : null}
      </header>

      {showLists && listsAllowed && (
        <ChatListsModal
          chat={chat}
          userId={userId}
          privateKeyB64={privateKeyB64}
          listEvent={listEvent}
          onSystemMessage={onListSystemMessage}
          onClose={() => {
            setShowLists(false);
            onListUnreadChangeRef.current?.(false);
            void clearListUnread(chat.id);
          }}
        />
      )}

      {showMembers && chat.type === 'group' && (
        <GroupMembersModal
          chat={chat}
          currentUserId={userId}
          privateKey={privateKey}
          isAdmin={isAdmin}
          onClose={() => setShowMembers(false)}
          onChatChanged={() => onMembersChanged()}
          onUpdated={(left) => {
            setShowMembers(false);
            onMembersChanged(left);
          }}
        />
      )}

      <div
        className={`messages${historyLoading && messages.length === 0 ? ' messages-booting' : ''}`}
        ref={messagesRef}
      >
        {(historyLoading || loadingOlder) && (
          <div className="messages-loading" aria-live="polite">
            {loadingOlder ? 'Загрузка истории…' : 'Загрузка сообщений…'}
          </div>
        )}
        {messages.map((m, i) => {
          const isOwn = m.senderId === userId;

          // Group consecutive image messages sharing an albumId into one tiled gallery.
          const range = m.type === 'image' ? albumRange(messages, i) : null;
          // Only the first member renders the album; later members are absorbed.
          if (range && range.start < i) return null;
          const albumMembers = range ? messages.slice(range.start, range.end + 1) : [];
          const isAlbum = albumMembers.length > 1;
          const openAlbum = (tileIndex: number) => {
            if (consumeSuppressClick()) return;
            closeContextMenu();
            // Full album gallery (all loaded photos) — swipe/arrows browse beyond the 4 tiles.
            const imgs = albumMembers
              .filter((am) => am.imageUrl)
              .map((am) => ({ src: am.imageUrl as string, imageId: am.imageId, messageId: am.id }));
            if (!imgs.length) return;
            const clickedId = albumMembers[tileIndex]?.id;
            const idx = Math.max(0, imgs.findIndex((im) => im.messageId === clickedId));
            setLightbox({ images: imgs, index: idx });
          };

          const menuOpen = !!(
            contextMenu &&
            sameMessageIdentity(m, {
              id: contextMenu.messageId,
              clientId: contextMenu.clientId,
            })
          );

          const canOpenMenu =
            !!messageClipboardText(m) ||
            isOwn ||
            canReplyToMessage(m) ||
            canSaveMessageMedia(m);

          const canSwipe = canReplyToMessage(m);
          const gestureHandlers = bindMessageGestures({
            messageId: m.id,
            canSwipeReply: canSwipe,
            canLongPress: canOpenMenu,
          });

          const firstInGroup = isFirstInMessageGroup(messages, i);
          const lastInGroup = isLastInMessageGroup(messages, i);
          const showDateDivider = firstInGroup && (
            i === 0 || !isSameDay(messages[i - 1].createdAt, m.createdAt)
          );
          const groupClass = firstInGroup && lastInGroup
            ? 'group-single'
            : firstInGroup
              ? 'group-first'
              : lastInGroup
                ? 'group-last'
                : 'group-middle';
          const sender = chat.type === 'group' && !isOwn
            ? chat.members.find((mem) => mem.id === m.senderId)
            : undefined;

          return (
            <div
              key={m.id}
              className={`message-wrap${highlightId === m.id ? ' message-highlight' : ''}`}
              data-message-id={m.id}
            >
              {showDateDivider && (
                <div className="date-divider" role="separator">
                  <span>{formatDateDivider(m.createdAt)}</span>
                </div>
              )}
              {m.type === 'call' || m.type === 'list' ? (
                <div
                  className={`call-event${m.type === 'list' ? ' list-event' : ''}${m.pending ? ' pending' : ''}`}
                  role="status"
                >
                  <span>
                    {m.type === 'call' ? callEventDisplayText(m.text) : listEventDisplayText(m.text)}
                  </span>
                </div>
              ) : (
              <div
                className={[
                  'message-row',
                  isOwn ? 'own' : 'other',
                  groupClass,
                  m.pending ? 'pending' : '',
                  canSwipe ? 'can-reply' : '',
                ].filter(Boolean).join(' ')}
                style={rowSwipeStyle(m.id)}
                {...gestureHandlers}
              >
                {canSwipe && (
                  <span
                    className={`swipe-reply-icon${isSwipeIconVisible(m.id) ? ' visible' : ''}`}
                    aria-hidden
                  >
                    <svg viewBox="0 0 24 24" width="22" height="22">
                      <path
                        fill="currentColor"
                        d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"
                      />
                    </svg>
                  </span>
                )}
                {chat.type === 'group' && !isOwn && (
                  firstInGroup ? (
                    <UserAvatar
                      userId={m.senderId}
                      name={m.senderName}
                      hasAvatar={sender?.hasAvatar}
                      avatarUpdatedAt={sender?.avatarUpdatedAt}
                      avatarUrl={sender?.avatarUrl}
                      className="message-avatar"
                    />
                  ) : (
                    <span className="message-avatar" aria-hidden />
                  )
                )}
                <div
                  ref={(el) => setBubbleEl(m.id, el)}
                  className={[
                    'message',
                    isOwn ? 'own' : '',
                    m.pending ? 'pending' : '',
                    groupClass,
                    isAlbum ? 'has-album' : '',
                    menuOpen ? 'menu-open' : '',
                  ].filter(Boolean).join(' ')}
                  onContextMenu={(e) => {
                    // Explicit desktop affordance (TASK-039); block native menus.
                    e.preventDefault();
                    e.stopPropagation();
                    if (!canOpenMenu) return;
                    openContextMenu(m, e.currentTarget);
                  }}
                >
                  {canOpenMenu && (
                    <button
                      type="button"
                      className="message-more-btn"
                      aria-label="Действия с сообщением"
                      data-no-message-gesture
                      onClick={(e) => {
                        e.stopPropagation();
                        // Explicit affordance always wins over leftover gesture suppress.
                        consumeSuppressClick();
                        if (menuOpen) {
                          closeContextMenu();
                          return;
                        }
                        const anchor = e.currentTarget.closest('.message');
                        if (!(anchor instanceof HTMLElement)) return;
                        openContextMenu(m, anchor);
                      }}
                    >
                      <span aria-hidden>⋮</span>
                    </button>
                  )}
                  {chat.type === 'group' && !isOwn && firstInGroup && (
                    <span className="sender">{m.senderName}</span>
                  )}
                  <MessageReplyQuote
                    message={m}
                    onOpen={
                      m.replyToMessageId
                        ? () => {
                            void scrollToReplied(m.replyToMessageId!);
                          }
                        : undefined
                    }
                  />
                  {m.type === 'image' && isAlbum ? (
                    <ChatImageAlbum
                      messages={albumMembers}
                      isOwn={isOwn}
                      read={
                        chat.type === 'direct' &&
                        !albumMembers.some((am) => am.pending) &&
                        chat.peerLastReadAt != null &&
                        albumMembers[albumMembers.length - 1].createdAt <= chat.peerLastReadAt
                      }
                      onOpen={openAlbum}
                      onDelete={isOwn ? () => requestDeleteMessage(m) : undefined}
                    />
                  ) : m.type === 'image' ? (
                    <ChatImageBubble
                      message={m}
                      isOwn={isOwn}
                      read={
                        chat.type === 'direct' &&
                        !m.pending &&
                        chat.peerLastReadAt != null &&
                        m.createdAt <= chat.peerLastReadAt
                      }
                      onOpen={() => {
                        if (consumeSuppressClick()) return;
                        closeContextMenu();
                        if (!m.imageUrl) return;
                        setLightbox({
                          images: [{ src: m.imageUrl, imageId: m.imageId, messageId: m.id }],
                          index: 0,
                        });
                      }}
                      onDelete={isOwn ? () => requestDeleteMessage(m) : undefined}
                    />
                  ) : m.type === 'video' ? (
                    <ChatVideoBubble
                      message={m}
                      isOwn={isOwn}
                      read={
                        chat.type === 'direct' &&
                        !m.pending &&
                        chat.peerLastReadAt != null &&
                        m.createdAt <= chat.peerLastReadAt
                      }
                      onOpen={() => {
                        if (consumeSuppressClick()) return;
                        closeContextMenu();
                        if (!m.imageUrl) return;
                        setVideoLightbox(m.imageUrl);
                      }}
                      onDelete={isOwn ? () => requestDeleteMessage(m) : undefined}
                    />
                  ) : (
                    <>
                      <div className="message-body">
                        <MessageText text={m.text} />
                        {m.type === 'text' && !m.text.startsWith('[') && <LinkPreview text={m.text} />}
                      </div>
                      {isOwn && m.failed && (
                        <div className="msg-text-error" role="alert">
                          <span className="msg-text-error-text">
                            Не отправлено{m.error ? `: ${m.error}` : ''}
                          </span>
                          <button
                            type="button"
                            className="msg-image-retry"
                            onClick={(e) => {
                              e.stopPropagation();
                              void retryOutboxItem(m.clientId || m.id);
                            }}
                          >
                            Повторить
                          </button>
                        </div>
                      )}
                      <time className="message-meta">
                        {formatMessageTime(m.createdAt)}
                        {isOwn && (
                          <MessageStatus
                            pending={!!m.pending}
                            read={
                              chat.type === 'direct' &&
                              !m.pending &&
                              !m.failed &&
                              chat.peerLastReadAt != null &&
                              m.createdAt <= chat.peerLastReadAt
                            }
                          />
                        )}
                      </time>
                    </>
                  )}
                </div>
              </div>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} className="messages-end" />
      </div>

      {contextMenu && contextMenuMessage && (
        <MessageContextMenu
          message={contextMenuMessage}
          anchorRect={contextMenu.anchorRect}
          alignment={contextMenuMessage.senderId === userId ? 'own' : 'incoming'}
          canReply={canReplyToMessage(contextMenuMessage)}
          canDelete={contextMenuMessage.senderId === userId}
          onClose={closeContextMenu}
          onAction={(id: MessageContextMenuActionId) => {
            const target = contextMenuMessage;
            if (id === 'reply') beginReply(target);
            else if (id === 'copy') void copyMessage(target);
            else if (id === 'save') void saveMessageMedia(target);
            else if (id === 'delete') requestDeleteMessage(target);
          }}
          selectedBubble={
            <div
              className={[
                'message',
                'msg-ctx-bubble-copy',
                contextMenuMessage.senderId === userId ? 'own' : '',
                contextMenuMessage.pending ? 'pending' : '',
                contextMenuMessage.type === 'image' ? 'has-album' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {chat.type === 'group' && contextMenuMessage.senderId !== userId && (
                <span className="sender">{contextMenuMessage.senderName}</span>
              )}
              <MessageReplyQuote message={contextMenuMessage} />
              {contextMenuMessage.type === 'image' && contextMenuMessage.imageUrl ? (
                <div className="msg-media-wrap">
                  <img
                    src={contextMenuMessage.imageUrl}
                    alt=""
                    className="msg-image"
                    draggable={false}
                  />
                </div>
              ) : contextMenuMessage.type === 'video' && contextMenuMessage.imageUrl ? (
                <div className="msg-media-wrap">
                  {contextMenuMessage.posterUrl ? (
                    <img
                      src={contextMenuMessage.posterUrl}
                      alt=""
                      className="msg-image"
                      draggable={false}
                    />
                  ) : (
                    <video
                      src={contextMenuMessage.imageUrl}
                      className="msg-image"
                      muted
                      playsInline
                      preload="metadata"
                    />
                  )}
                </div>
              ) : (
                <div className="message-body">
                  <MessageText text={contextMenuMessage.text} />
                </div>
              )}
              <time className="message-meta">
                {formatMessageTime(contextMenuMessage.createdAt)}
              </time>
            </div>
          }
        />
      )}

      <footer className="chat-compose">
        {!isAtBottom && !lightbox && !videoLightbox && (
          <button
            type="button"
            className="chat-scroll-bottom"
            // Same as compose-send: do not steal focus from the textarea, or iOS
            // dismisses the soft keyboard when jumping to the latest messages.
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={jumpToLatest}
            aria-label={
              unreadBelowCount > 0
                ? `К новым сообщениям (${formatUnreadBelowBadge(unreadBelowCount)})`
                : 'К последним сообщениям'
            }
          >
            <span className="chat-scroll-bottom-arrow" aria-hidden>
              ↓
            </span>
            {unreadBelowCount > 0 && (
              <span className="chat-scroll-bottom-badge">
                {formatUnreadBelowBadge(unreadBelowCount)}
              </span>
            )}
          </button>
        )}
        {replyTo && (
          <div className="compose-reply">
            <span className="compose-reply-bar" aria-hidden />
            <div className="compose-reply-body">
              <div className="compose-reply-author">{replyTo.replyToSenderName}</div>
              <div className="compose-reply-text">{replyTo.replyToPreview}</div>
            </div>
            <button
              type="button"
              className="compose-reply-close"
              onClick={cancelReply}
              aria-label="Отменить ответ"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
                <path
                  fill="currentColor"
                  d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
                />
              </svg>
            </button>
          </div>
        )}
        <div className="compose-main">
          <input
            ref={fileRef}
            type="file"
            accept={MEDIA_ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              const input = e.target;
              const files = input.files ? Array.from(input.files) : [];
              if (!files.length) {
                input.value = '';
                return;
              }
              void sendMedia(files).finally(() => {
                input.value = '';
              });
            }}
          />
          <button
            type="button"
            className="compose-attach"
            onClick={() => fileRef.current?.click()}
            title="Фото или видео"
            aria-label="Прикрепить фото или видео"
            disabled={sending}
          >
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden><path fill="currentColor" d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 0 1 5 0v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5a2.5 2.5 0 0 0 5 0V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>
          </button>
          <div className="compose-input-wrap">
            <textarea
              ref={composeRef}
              className="compose-input"
              placeholder={replyTo ? 'Ваш ответ' : 'Сообщение'}
              value={text}
              rows={1}
              onChange={(e) => {
                setText(e.target.value);
                if (e.target.value.trim()) bumpTyping();
                else stopTyping();
              }}
              onFocus={() => {
                composerFocusedRef.current = true;
                // Snapshot before visualViewport / IME mutates layout (TASK-018).
                const scroller = messagesRef.current;
                if (scroller) keyboardScrollTopLockRef.current = scroller.scrollTop;
              }}
              onBlur={() => {
                composerFocusedRef.current = false;
                // Keep the lock through keyboard-close settle; clear shortly after.
                window.setTimeout(() => {
                  if (!composerFocusedRef.current && !isVisualViewportShellActive()) {
                    keyboardScrollTopLockRef.current = null;
                  }
                }, 600);
                stopTyping();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && replyTo) {
                  e.preventDefault();
                  cancelReply();
                  return;
                }
                if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
                // On phones, Return inserts a newline; send via the button.
                if (window.matchMedia('(pointer: coarse)').matches) return;
                e.preventDefault();
                void sendText();
              }}
              enterKeyHint="enter"
              autoComplete="off"
              autoCorrect="on"
            />
          </div>
          <button
            type="button"
            className={`compose-send ${text.trim() ? 'has-text' : ''}`}
            // preventDefault keeps focus in the textarea so the soft keyboard stays open.
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void sendText()}
            disabled={sending || !text.trim()}
            aria-label="Отправить"
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden><path fill="currentColor" d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </div>
      </footer>

      {lightbox && (
        <ImageLightbox
          images={lightbox.images}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
        />
      )}
      {videoLightbox && (
        <VideoLightbox src={videoLightbox} onClose={() => setVideoLightbox(null)} />
      )}
      {deleteTarget && (
        <ConfirmDialog
          title={deleteConfirmCopy.title}
          body={deleteConfirmCopy.body}
          confirmLabel="Удалить"
          cancelLabel="Отмена"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void removeMessage(deleteTarget)}
        />
      )}
    </div>
  );
}
