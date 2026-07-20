import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import type { Chat } from '../lib/api';
import { api } from '../lib/api';
import type { StoredMessage } from '../lib/storage';
import { getMessages, saveMessage, deleteMessageLocal } from '../lib/storage';
import { decryptMessage } from '../lib/messages';
import { encryptChatMessage, getChatEncryptionKey, PLAIN_IV } from '../lib/messages-encrypt';
import { prepareChatImage, compressChatImage } from '../lib/image';
import { hydrateStoredMessages, migrateLocalPreview, persistLocalPreview } from '../lib/image-preview';
import { enqueueTextOutbox, enqueueImageOutbox, flushOutbox, OUTBOX_FLUSHED_EVENT, OUTBOX_FAILED_EVENT } from '../lib/outbox';
import { isOnline } from '../lib/network';
import { formatDateDivider, formatMessageTime, isFirstInMessageGroup, isLastInMessageGroup, isSameDay, chatInitials, peerStatusText, albumRange } from '../lib/chat-format';
import { callEventDisplayText } from '../lib/call-events';
import { listEventDisplayText } from '../lib/list-events';
import { dedupeStoredMessages } from '../lib/message-dedupe';
import { notify } from '../lib/notify';
import { GroupMembersModal } from './GroupMembersModal';
import { LinkPreview } from './LinkPreview';
import { MessageText } from './MessageText';
import { MessageStatus } from './MessageStatus';
import { ChatImageBubble } from './ChatImageBubble';
import { ChatImageAlbum } from './ChatImageAlbum';
import { UserAvatar } from './UserAvatar';
import { ImageLightbox } from './ImageLightbox';
import { ChatListsModal, type ChatListEvent } from './ChatListsModal';
import { checkListUnreadFromServer, clearListUnread } from '../lib/list-sync';
import { syncSystemGroupKeys } from '../lib/system-group';

interface Props {
  chat: Chat;
  userId: string;
  privateKey: CryptoKey;
  privateKeyB64: string;
  onBack?: () => void;
  onMembersChanged: (left?: boolean) => void;
  onClearChat?: () => void;
  canClearChat?: boolean;
  onRead?: (at: number) => void;
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
}

export function ChatView({
  chat,
  userId,
  privateKey,
  privateKeyB64,
  onBack,
  onMembersChanged,
  onClearChat,
  canClearChat = false,
  onRead,
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
}: Props) {
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
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
  const [menuMessageId, setMenuMessageId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{
    images: { src: string; imageId?: string | null; messageId?: string | null }[];
    index: number;
  } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const headerMenuRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const openingChatRef = useRef(true);
  const initialLoadRef = useRef(true);
  const scrollAnchorRef = useRef<{ top: number; height: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);

  const resizeCompose = useCallback(() => {
    const el = composeRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, []);

  useLayoutEffect(() => {
    resizeCompose();
  }, [text, resizeCompose]);

  const isNearBottom = useCallback((el: HTMLElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  }, []);

  const scrollToEnd = useCallback(() => {
    const el = messagesRef.current;
    if (!el) return;
    const jump = () => {
      el.scrollTop = el.scrollHeight;
      bottomRef.current?.scrollIntoView({ block: 'end' });
    };
    jump();
    requestAnimationFrame(() => {
      jump();
      requestAnimationFrame(jump);
    });
  }, []);

  const updateMessages = useCallback((
    updater: StoredMessage[] | ((prev: StoredMessage[]) => StoredMessage[]),
    opts?: { stickToBottom?: boolean },
  ) => {
    const el = messagesRef.current;
    const shouldStick = opts?.stickToBottom || openingChatRef.current || initialLoadRef.current;
    if (shouldStick) {
      stickToBottomRef.current = true;
    } else if (el && !openingChatRef.current && !initialLoadRef.current && !isNearBottom(el)) {
      scrollAnchorRef.current = { top: el.scrollTop, height: el.scrollHeight };
    }
    setMessages(updater);
  }, [isNearBottom]);

  const usernames = new Map(chat.members.map((m) => [m.id, m.username]));
  const myGroupWrap = chat.members.find((m) => m.id === userId)?.encryptedGroupKey ?? '';
  const loadAndDecrypt = useCallback(async () => {
    const nameById = new Map(chat.members.map((m) => [m.id, m.username]));
    const cached = dedupeStoredMessages(await hydrateStoredMessages(await getMessages(chat.id)));
    try {
      if (cached.length) {
        updateMessages(
          cached.sort((a, b) => a.createdAt - b.createdAt),
          openingChatRef.current ? { stickToBottom: true } : undefined,
        );
      }

      // Always attempt network — Capacitor Android often reports navigator.onLine=false.
      // Warm group key so encrypted history decrypts.
      // Refresh chat from API first — local cache may lack encryptedGroupKey / have a stale wrap.
      let chatForDecrypt = chat;
      if (chat.type === 'group') {
        try {
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
          // Prefer server wrap over any stale local AES key (same epoch).
          await getChatEncryptionKey(chatForDecrypt, userId, privateKeyB64, {
            forceRefresh: true,
          });
        } catch {
          // Messages may still load once wrap/key is available.
        }
      }

      // Always backfill from the start. Incremental-only sync (after=lastAt) skips older
      // history when local storage was wiped / only recent WS messages remained.
      const raw = await api.getAllMessages(chat.id, 0);
      const decrypted: StoredMessage[] = [];

      for (const msg of raw) {
        try {
          const existing = cached.find((m) => m.id === msg.id);
          if (existing && msg.senderId === userId) {
            const [hydrated] = await hydrateStoredMessages([
              { ...existing, clientId: msg.clientId || existing.clientId },
            ]);
            decrypted.push(hydrated);
            continue;
          }
          if (msg.senderId === userId) {
            const pending = cached.find(
              (m) =>
                m.pending &&
                m.senderId === userId &&
                !!msg.clientId &&
                (m.clientId === msg.clientId || m.id === msg.clientId),
            );
            if (pending) {
              const stored: StoredMessage = {
                ...pending,
                id: msg.id,
                createdAt: msg.createdAt,
                pending: false,
                imageId: msg.imageId,
                albumId: msg.albumId ?? pending.albumId,
                clientId: msg.clientId || pending.clientId || pending.id,
              };
              if (msg.type === 'image' && msg.imageId) {
                await migrateLocalPreview(pending.id, msg.id, msg.imageId);
              }
              const hydrated = (await hydrateStoredMessages([stored]))[0];
              const { replacePendingMessage } = await import('../lib/storage');
              await replacePendingMessage(pending.id, hydrated);
              decrypted.push(hydrated);
              continue;
            }
          }
          const { text: plain } = await decryptMessage(msg, chatForDecrypt, userId, privateKeyB64, nameById);
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
            clientId: msg.clientId,
            createdAt: msg.createdAt,
          };
          // Don't permanently overwrite history with a decrypt failure.
          if (plain !== '[не удалось расшифровать]') {
            await saveMessage(stored);
          }
          const [hydrated] = await hydrateStoredMessages([stored]);
          decrypted.push(hydrated);
        } catch {
          // One bad message must not abort the whole history load (iOS PWA).
        }
      }

      if (decrypted.length) {
        const stillPendingIds = new Set(
          (await getMessages(chat.id)).filter((m) => m.pending).map((m) => m.id),
        );
        updateMessages((prev) => {
          const map = new Map(prev.filter((m) => !m.pending).map((m) => [m.id, m]));
          for (const m of decrypted) map.set(m.id, m);
          const confirmed = [...map.values()];
          const pending = prev.filter((m) => m.pending && stillPendingIds.has(m.id));
          const pendingDeduped = pending.filter(
            (p) =>
              !confirmed.some(
                (c) =>
                  !c.pending &&
                  !!p.clientId &&
                  (c.clientId === p.clientId || c.id === p.clientId),
              ),
          );
          return dedupeStoredMessages([...confirmed, ...pendingDeduped]);
        });
      }

      const all = await getMessages(chat.id);
      const latest = all.filter((m) => !m.pending).reduce((max, m) => Math.max(max, m.createdAt), 0);
      if (latest > 0) onRead?.(latest);
    } catch {
      const latest = cached.filter((m) => !m.pending).reduce((max, m) => Math.max(max, m.createdAt), 0);
      if (latest > 0) onRead?.(latest);
    } finally {
      initialLoadRef.current = false;
      openingChatRef.current = false;
      stickToBottomRef.current = true;
      scrollToEnd();
    }
  }, [chat, userId, privateKeyB64, onRead, updateMessages, scrollToEnd]);

  useEffect(() => {
    openingChatRef.current = true;
    initialLoadRef.current = true;
    stickToBottomRef.current = true;
    scrollAnchorRef.current = null;
    setMessages([]);
    setShowLists(false);
    void loadAndDecrypt();
    // Re-run when group wrap arrives (common on slow iOS PWA after local cache paint).
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
    if (!incomingMessage || incomingMessage.chatId !== chat.id) return;
    updateMessages((prev) => {
      if (prev.some((m) => m.id === incomingMessage.id)) return prev;
      return [...prev, incomingMessage].sort((a, b) => a.createdAt - b.createdAt);
    }, { stickToBottom: stickToBottomRef.current });
  }, [incomingMessage, chat.id, updateMessages]);

  useEffect(() => {
    if (!deletedMessage || deletedMessage.chatId !== chat.id) return;
    if (deletedMessage.messageId === '*') {
      setMenuMessageId(null);
      // Reload from storage — unsent outbox items may have been reinstated as pending.
      void (async () => {
        const fresh = dedupeStoredMessages(await hydrateStoredMessages(await getMessages(chat.id)));
        updateMessages(fresh.sort((a, b) => a.createdAt - b.createdAt), { stickToBottom: true });
      })();
      return;
    }
    updateMessages((prev) => prev.filter((m) => m.id !== deletedMessage.messageId));
    setMenuMessageId((id) => (id === deletedMessage.messageId ? null : id));
  }, [deletedMessage, chat.id, updateMessages]);

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

  useEffect(() => {
    if (!menuMessageId) return;
    const close = () => setMenuMessageId(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuMessageId]);

  const copyMessage = async (m: StoredMessage) => {
    setMenuMessageId(null);
    const text = m.type === 'image' ? (m.text || 'Изображение') : m.text;
    try {
      await navigator.clipboard.writeText(text);
      notify.success('Скопировано');
    } catch {
      notify.warning('Не удалось скопировать');
    }
  };

  const removeMessage = async (m: StoredMessage) => {
    setMenuMessageId(null);
    // Deleting any photo in a tiled album removes the whole album.
    const targets =
      m.type === 'image' && m.albumId
        ? messages.filter((x) => x.type === 'image' && x.albumId === m.albumId)
        : [m];
    const label =
      targets.length > 1 ? `Удалить альбом (${targets.length} фото)?` : 'Удалить сообщение?';
    if (!window.confirm(label)) return;
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
      const gone = new Set(targets.map((t) => t.id));
      updateMessages((prev) => prev.filter((x) => !gone.has(x.id)));
      onMessagesChanged?.();
    } catch (e) {
      notify.error(e instanceof Error ? e.message : 'Не удалось удалить');
    }
  };

  const refreshFromStorage = useCallback(async () => {
    const fresh = dedupeStoredMessages(await hydrateStoredMessages(await getMessages(chat.id)));
    updateMessages(fresh.sort((a, b) => a.createdAt - b.createdAt), { stickToBottom: true });
  }, [chat.id, updateMessages]);

  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) void loadAndDecrypt();
    };
    const onFlushed = () => {
      // Prefer storage reload: pending→real id already applied by outbox replace.
      void refreshFromStorage();
    };
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener(OUTBOX_FLUSHED_EVENT, onFlushed);
    window.addEventListener(OUTBOX_FAILED_EVENT, onFlushed);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
      window.removeEventListener(OUTBOX_FLUSHED_EVENT, onFlushed);
      window.removeEventListener(OUTBOX_FAILED_EVENT, onFlushed);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [loadAndDecrypt, refreshFromStorage]);

  useLayoutEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    if (openingChatRef.current || initialLoadRef.current || stickToBottomRef.current) {
      scrollToEnd();
      if (openingChatRef.current && messages.length > 0) {
        openingChatRef.current = false;
      }
      scrollAnchorRef.current = null;
      return;
    }
    if (scrollAnchorRef.current) {
      const { top, height } = scrollAnchorRef.current;
      el.scrollTop = top + (el.scrollHeight - height);
      scrollAnchorRef.current = null;
    }
  }, [messages, scrollToEnd]);

  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const onLoad = () => {
      if (stickToBottomRef.current) scrollToEnd();
    };
    el.addEventListener('load', onLoad, true);
    return () => el.removeEventListener('load', onLoad, true);
  }, [chat.id, scrollToEnd]);

  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const onScroll = () => {
      if (openingChatRef.current || initialLoadRef.current) return;
      stickToBottomRef.current = isNearBottom(el);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [chat.id, isNearBottom]);

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

  const sendText = async () => {
    if (!text.trim() || sending) return;
    stopTyping();
    setSending(true);
    const plain = text.trim();
    const tempId = `pending-${crypto.randomUUID()}`;
    let queued = false;
    try {
      const { ciphertext, iv } = await encryptChatMessage(plain, chat, userId, privateKeyB64);
      // Outbox first — ciphertext must be durable before UI claims success.
      await enqueueTextOutbox(chat.id, tempId, ciphertext, iv, plain);
      queued = true;

      const pending: StoredMessage = {
        id: tempId,
        chatId: chat.id,
        senderId: userId,
        senderName: usernames.get(userId) || 'Я',
        text: plain,
        type: 'text',
        clientId: tempId,
        createdAt: Date.now(),
        pending: true,
      };
      await saveMessage(pending);
      updateMessages((prev) => [...prev, pending], { stickToBottom: true });
      setText('');
      onMessagesChanged?.();
    } catch {
      notify.error('Не удалось подготовить сообщение.');
      // If outbox write succeeded, keep it — flush will materialize the local row on ACK.
    } finally {
      setSending(false);
    }

    if (!queued) return;
    // Force: don't wait out a previous backoff — user just tapped send.
    // Catch: flush used to reject/hang silently and leave the bubble on «часиках».
    void flushOutbox({ force: true })
      .then((sent) => {
        if (sent > 0) {
          void refreshFromStorage();
        } else if (!isOnline()) {
          notify.info('Сообщение будет отправлено при появлении сети');
        } else {
          // Online but nothing ACKed — reload in case another flush finalized it,
          // or surface orphan pending as failed.
          void refreshFromStorage();
        }
      })
      .catch((err) => {
        console.warn('flush after text send failed', err);
        notify.error(err instanceof Error ? err.message : 'Не удалось отправить сообщение');
        void refreshFromStorage();
      });
  };

  const MAX_IMAGES_PER_PICK = 30;

  const queueImage = async (
    file: File,
    createdAt: number,
    albumId?: string,
  ): Promise<boolean> => {
    // Compress client-side (resize + re-encode) before queueing; fall back to the
    // original bytes if the browser cannot decode this image.
    let processed: Blob;
    try {
      const compressed = await compressChatImage(file);
      processed = compressed.blob;
    } catch {
      processed = await prepareChatImage(file);
    }
    const previewData = await processed.arrayBuffer();
    const mimeType = processed.type || 'image/jpeg';

    const tempId = `pending-${crypto.randomUUID()}`;
    // Photos are NOT E2E-encrypted: bytes go to object storage as-is, and the
    // small message envelope is plaintext too (iv=plain).
    const msgPlain = JSON.stringify({ name: file.name || 'photo' });

    // Separate copies for upload payload vs local preview — avoids shared-buffer detach races.
    const uploadBytes = previewData.slice(0);
    const previewBytes = previewData.slice(0);
    await enqueueImageOutbox(
      chat.id,
      tempId,
      uploadBytes,
      mimeType,
      msgPlain,
      PLAIN_IV,
      previewBytes,
      mimeType,
      albumId,
    );

    const pending: StoredMessage = {
      id: tempId,
      chatId: chat.id,
      senderId: userId,
      senderName: usernames.get(userId) || 'Я',
      text: '📷 Изображение',
      type: 'image',
      albumId,
      clientId: tempId,
      createdAt,
      pending: true,
    };
    await persistLocalPreview(tempId, previewBytes, mimeType);
    await saveMessage(pending);
    const [hydratedPending] = await hydrateStoredMessages([pending]);
    updateMessages((prev) => [...prev, hydratedPending], { stickToBottom: true });
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
      for (let i = 0; i < snapshots.length; i++) {
        try {
          await queueImage(snapshots[i], base + i, albumId);
          queued++;
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

  return (
    <div className="chat-view">
      <header className="chat-view-header">
        {onBack && (
          <button type="button" className="tg-back-btn" onClick={onBack} aria-label="Назад">
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden><path fill="currentColor" d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
          </button>
        )}
        {chat.type === 'group' ? (
          <span className={`chat-avatar group`} aria-hidden>
            {chat.isSystem ? '🌐' : '👥'}
          </span>
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
        {canClearChat && onClearChat && (
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
              </div>
            )}
          </div>
        )}
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
          onClose={() => setShowMembers(false)}
          onUpdated={(left) => {
            setShowMembers(false);
            onMembersChanged(left);
          }}
        />
      )}

      <div className="messages" ref={messagesRef}>
        {messages.map((m, i) => {
          const isOwn = m.senderId === userId;

          // Group consecutive image messages sharing an albumId into one tiled gallery.
          const range = m.type === 'image' ? albumRange(messages, i) : null;
          // Only the first member renders the album; later members are absorbed.
          if (range && range.start < i) return null;
          const albumMembers = range ? messages.slice(range.start, range.end + 1) : [];
          const isAlbum = albumMembers.length > 1;
          const openAlbum = (tileIndex: number) => {
            setMenuMessageId(null);
            // Full album gallery (all loaded photos) — swipe/arrows browse beyond the 4 tiles.
            const imgs = albumMembers
              .filter((am) => am.imageUrl)
              .map((am) => ({ src: am.imageUrl as string, imageId: am.imageId, messageId: am.id }));
            if (!imgs.length) return;
            const clickedId = albumMembers[tileIndex]?.id;
            const idx = Math.max(0, imgs.findIndex((im) => im.messageId === clickedId));
            setLightbox({ images: imgs, index: idx });
          };

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
            <div key={m.id} className="message-wrap">
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
                ].filter(Boolean).join(' ')}
              >
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
                  className={[
                    'message',
                    isOwn ? 'own' : '',
                    m.pending ? 'pending' : '',
                    groupClass,
                    isAlbum ? 'has-album' : '',
                    menuMessageId === m.id ? 'menu-open' : '',
                  ].filter(Boolean).join(' ')}
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    const canCopy = m.type === 'text' && !!m.text && !m.text.startsWith('[');
                    if (!canCopy && !isOwn) return;
                    setMenuMessageId((id) => (id === m.id ? null : m.id));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      const canCopy = m.type === 'text' && !!m.text && !m.text.startsWith('[');
                      if (!canCopy && !isOwn) return;
                      setMenuMessageId((id) => (id === m.id ? null : m.id));
                    }
                  }}
                >
                  {chat.type === 'group' && !isOwn && firstInGroup && (
                    <span className="sender">{m.senderName}</span>
                  )}
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
                        setMenuMessageId(null);
                        if (!m.imageUrl) return;
                        setLightbox({
                          images: [{ src: m.imageUrl, imageId: m.imageId, messageId: m.id }],
                          index: 0,
                        });
                      }}
                    />
                  ) : (
                    <>
                      <div className="message-body">
                        <MessageText text={m.text} />
                        {m.type === 'text' && !m.text.startsWith('[') && <LinkPreview text={m.text} />}
                      </div>
                      <time className="message-meta">
                        {formatMessageTime(m.createdAt)}
                        {isOwn && (
                          <MessageStatus
                            pending={!!m.pending}
                            read={
                              chat.type === 'direct' &&
                              !m.pending &&
                              chat.peerLastReadAt != null &&
                              m.createdAt <= chat.peerLastReadAt
                            }
                          />
                        )}
                      </time>
                    </>
                  )}
                  {menuMessageId === m.id && (
                    <div
                      className={`message-actions ${isOwn ? 'own' : 'other'}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {m.type === 'text' && !!m.text && !m.text.startsWith('[') && (
                        <button type="button" onClick={() => void copyMessage(m)}>
                          Скопировать
                        </button>
                      )}
                      {isOwn && (
                        <button type="button" className="danger" onClick={() => void removeMessage(m)}>
                          Удалить
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} className="messages-end" />
      </div>

      <footer className="chat-compose">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const input = e.target;
            const files = input.files ? Array.from(input.files) : [];
            if (!files.length) {
              input.value = '';
              return;
            }
            // Clear only after sendImages has copied file bytes (see snapshot in sendImages).
            void sendImages(files).finally(() => {
              input.value = '';
            });
          }}
        />
        <button
          type="button"
          className="compose-attach"
          onClick={() => fileRef.current?.click()}
          title="Фото"
          aria-label="Прикрепить фото"
          disabled={sending}
        >
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden><path fill="currentColor" d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 0 1 5 0v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5a2.5 2.5 0 0 0 5 0V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>
        </button>
        <div className="compose-input-wrap">
          <textarea
            ref={composeRef}
            className="compose-input"
            placeholder="Сообщение"
            value={text}
            rows={1}
            onChange={(e) => {
              setText(e.target.value);
              if (e.target.value.trim()) bumpTyping();
              else stopTyping();
            }}
            onBlur={stopTyping}
            onKeyDown={(e) => {
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
          onClick={sendText}
          disabled={sending || !text.trim()}
          aria-label="Отправить"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden><path fill="currentColor" d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </footer>

      {lightbox && (
        <ImageLightbox
          images={lightbox.images}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}
