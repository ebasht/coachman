import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuth } from './hooks/useAuth';
import { useWebSocket } from './hooks/useWebSocket';
import { notify } from './lib/notify';
import { updateTabBadge, clearTabBadge, syncTabBadge, isTabVisible } from './lib/tab-badge';
import { AuthScreen } from './components/AuthScreen';
import { ChatList } from './components/ChatList';
import { ChatView } from './components/ChatView';
import { CreateGroupModal } from './components/CreateGroupModal';
import { api, type Chat, type RawMessage } from './lib/api';
import { saveMessage, deleteGroupKey, clearChatMessagesLocal, deleteMessageLocal, updateChatPeerReadAt, getMessages, listPrefetchChatIds, deleteChatLocal, type StoredMessage } from './lib/storage';
import {
  chatsFromLocalStore,
  replaceLocalChatsFromApi,
  enrichChatsWithPreviews,
  removeChatFromList,
} from './lib/offline-chats';
import { decryptMessage } from './lib/messages';
import { hydrateStoredMessages } from './lib/image-preview';
import { messagePreview } from './lib/chat-format';
import { consumePrefetchedMessages, prefetchChatInBackground } from './lib/background-prefetch';
import { InviteModal } from './components/InviteModal';
import { AdminUsersModal } from './components/AdminUsersModal';
import { SettingsModal } from './components/SettingsModal';
import { visibleChatsForUser } from './lib/admin-chat';
import { syncSystemGroupKeys } from './lib/system-group';
import {
  flushOutbox,
  hasOutboxItems,
  isOutboxCoolingDown,
  purgeStuckOutboxOnce,
  failOrphanPendingMessages,
  setOutboxAuthRetry,
  setOutboxErrorReporter,
  OUTBOX_FLUSHED_EVENT,
} from './lib/outbox';
import { flushListOutbox, listEventActorId, markListUnread } from './lib/list-sync';
import { UnlockScreen } from './components/UnlockScreen';
import { computeUnreadCounts, setLastReadAt } from './lib/unread';
import { syncPushSubscription, unsubscribeFromPush, onEnablePushClick, prefetchPushConfig } from './lib/push-subscribe';
import { usePushPermission } from './hooks/usePushPermission';
import { useAppRoute } from './hooks/useAppRoute';
import { useVisualViewport } from './hooks/useVisualViewport';
import { useVideoCall } from './hooks/useVideoCall';
import { VideoCallOverlay } from './components/VideoCallOverlay';
import type { CallSignal } from './lib/call-types';
import type { CallEventReport } from './lib/call-events';
import { postCallEventMessage } from './lib/call-events';
import { loadPendingCallInviteAsync, markCallDismissed, clearPendingCallInvite, savePendingCallInvite } from './lib/pending-call-invite';
import {
  dismissNativeIncomingCall,
  isNativeAndroid,
  setNativeCallPushHandler,
  setNativeInCallSession,
  truthyFlag,
} from './lib/native-calls';
import { CoachmanCalls } from './lib/coachman-calls';
import type { ChatListEvent } from './components/ChatListsModal';

export default function App() {
  useVisualViewport();
  const { auth, lockedAccount, localAccounts, loading, error, register, loginLocal, unlock, logout, removeFromDevice, refreshSession, updateAvatar, markAsAdmin } = useAuth();
  const { route, navigate } = useAppRoute(!!auth);
  const { permission: pushPerm, needsInstall: pushNeedsInstall, refresh: refreshPushPermission } = usePushPermission();
  const [chats, setChats] = useState<Chat[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const onlineRef = useRef(navigator.onLine);
  const [privateKeyB64, setPrivateKeyB64] = useState('');
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [liveMessage, setLiveMessage] = useState<StoredMessage | null>(null);
  const [deletedMessage, setDeletedMessage] = useState<{ chatId: string; messageId: string } | null>(null);
  const [chatListEvent, setChatListEvent] = useState<(ChatListEvent & { seq: number }) | null>(null);
  const chatListSeqRef = useRef(0);
  const [listUnreadByChat, setListUnreadByChat] = useState<Record<string, boolean>>({});
  const [typingByChat, setTypingByChat] = useState<Record<string, string>>({});
  const sendCallRef = useRef<(signal: Omit<CallSignal, 'fromUserId'>) => void>(() => {});
  const incomingCallFromPushRef = useRef<
    (payload: CallSignal, opts?: { autoAccept?: boolean; autoReject?: boolean }) => void
  >(() => {});
  const endCallFromPushRef = useRef<
    (payload: { callId: string; chatId: string; fromUserId?: string }) => void
  >(() => {});
  const queuedPushCallRef = useRef<{
    payload: CallSignal;
    opts?: { autoAccept?: boolean; autoReject?: boolean };
  } | null>(null);
  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  const authRef = useRef(auth);
  authRef.current = auth;
  const typingClearTimers = useRef<Record<string, number>>({});
  const unreadTotal = useMemo(
    () => Object.values(unreadCounts).reduce((sum, count) => sum + count, 0),
    [unreadCounts],
  );
  const unreadCountsRef = useRef(unreadCounts);
  unreadCountsRef.current = unreadCounts;
  const activeChatId = route.chatId;
  const activeChatIdRef = useRef<string | null>(null);
  const tabVisibleRef = useRef(isTabVisible());
  activeChatIdRef.current = activeChatId;
  /** Bumped to force ChatView to re-fetch history (push wake / failed live hydrate). */
  const [chatSyncTick, setChatSyncTick] = useState(0);
  const bumpChatSync = useCallback((chatId?: string | null) => {
    if (chatId && activeChatIdRef.current && chatId !== activeChatIdRef.current) return;
    setChatSyncTick((n) => n + 1);
  }, []);
  const scheduleLoadChatsRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!auth) return;
    void prefetchPushConfig();
    let pushSyncTimer: number | undefined;
    const syncPush = () => {
      window.clearTimeout(pushSyncTimer);
      pushSyncTimer = window.setTimeout(() => {
        void syncPushSubscription().catch((e) => console.warn('push sync failed', e));
      }, document.hidden ? 0 : 400);
    };
    syncPush();
    const interval = window.setInterval(() => {
      if (!document.hidden) void syncPushSubscription().catch(() => {});
    }, 10 * 60 * 1000);
    document.addEventListener('visibilitychange', syncPush);
    window.addEventListener('focus', syncPush);
    return () => {
      window.clearTimeout(pushSyncTimer);
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', syncPush);
      window.removeEventListener('focus', syncPush);
    };
  }, [auth?.userId]);

  useEffect(() => {
    if (!auth) return;
    const resetBadge = () => {
      if (document.hidden) return;
      void api.resetPushBadge().catch(() => {});
      // Re-apply launcher badge from local unread (Android: clears stale FCM trays).
      syncTabBadge(unreadCountsRef.current);
    };
    resetBadge();
    document.addEventListener('visibilitychange', resetBadge);
    window.addEventListener('focus', resetBadge);
    return () => {
      document.removeEventListener('visibilitychange', resetBadge);
      window.removeEventListener('focus', resetBadge);
    };
  }, [auth?.userId]);

  const applyBackgroundPrefetch = useCallback(
    async (chatId: string) => {
      if (!auth || !privateKeyB64 || !chatId) return 0;
      let raw: Awaited<ReturnType<typeof consumePrefetchedMessages>>;
      try {
        raw = await consumePrefetchedMessages(chatId);
      } catch {
        return 0;
      }
      if (!raw.length) return 0;

      let chat = chats.find((c) => c.id === chatId);
      if (!chat) {
        // Never resurrect from local IDB — deleted chats must stay gone until
        // GET /chats says they exist again.
        try {
          const fresh = await enrichChatsWithPreviews(await api.getChats());
          if (fresh.length === 0 && chatsRef.current.length > 0) return 0;
          setChats(fresh);
          await replaceLocalChatsFromApi(fresh, auth.userId);
          chat = fresh.find((c) => c.id === chatId);
        } catch {
          return 0;
        }
      }
      if (!chat) return 0;

      const usernames = new Map(chat.members.map((m) => [m.id, m.username]));
      let lastStored: StoredMessage | null = null;
      for (const msg of raw) {
        if (msg.senderId === auth.userId) continue;
        try {
          const { text, imageUrl } = await decryptMessage(
            msg,
            chat,
            auth.userId,
            privateKeyB64,
            usernames,
          );
          if (msg.type !== 'image' && text === '[не удалось расшифровать]') continue;
          const stored: StoredMessage = {
            id: msg.id,
            chatId: msg.chatId,
            senderId: msg.senderId,
            senderName: usernames.get(msg.senderId) || '?',
            text: text === '[не удалось расшифровать]' ? '…' : text,
            type: msg.type,
            imageId: msg.imageId,
            albumId: msg.albumId,
            imageUrl,
            createdAt: msg.createdAt,
          };
          await saveMessage(stored);
          lastStored = stored;
        } catch {
          // leave for normal history sync
        }
      }

      if (lastStored) {
        setChats((prev) =>
          prev.map((c) =>
            c.id === chatId
              ? {
                  ...c,
                  lastMessage: {
                    id: lastStored!.id,
                    senderId: lastStored!.senderId,
                    type: lastStored!.type,
                    createdAt: lastStored!.createdAt,
                  },
                  lastMessagePreview: messagePreview(lastStored!),
                }
              : c,
          ),
        );
        if (activeChatIdRef.current === chatId) {
          const [hydrated] = await hydrateStoredMessages([lastStored]);
          setLiveMessage(hydrated);
        }
      }
      return raw.length;
    },
    [auth, privateKeyB64, chats],
  );

  const applyBackgroundPrefetchRef = useRef(applyBackgroundPrefetch);
  applyBackgroundPrefetchRef.current = applyBackgroundPrefetch;

  // On login: decrypt SW-prefetched rows after first paint (don't block chat list).
  useEffect(() => {
    if (!auth || !privateKeyB64) return;
    let cancelled = false;
    const run = () => {
      void (async () => {
        const ids = await listPrefetchChatIds();
        if (cancelled || !ids.length) return;
        for (const id of ids) {
          if (cancelled) return;
          await applyBackgroundPrefetchRef.current(id);
          // Yield so UI stays responsive while decrypting.
          await new Promise((r) => setTimeout(r, 0));
        }
        scheduleLoadChatsRef.current();
        if (activeChatIdRef.current) bumpChatSync(activeChatIdRef.current);
      })();
    };
    let idleId: number | undefined;
    let timeoutId: number | undefined;
    if (typeof requestIdleCallback === 'function') {
      idleId = requestIdleCallback(run, { timeout: 1200 });
    } else {
      timeoutId = window.setTimeout(run, 300);
    }
    return () => {
      cancelled = true;
      if (idleId != null && typeof cancelIdleCallback === 'function') {
        cancelIdleCallback(idleId);
      }
      if (timeoutId != null) window.clearTimeout(timeoutId);
    };
  }, [auth, privateKeyB64, bumpChatSync]);

  useEffect(() => {
    const handlePrefetchSignal = (chatId: string | null | undefined, kind: 'message-push' | 'prefetch-ready') => {
      if (!chatId || !authRef.current) return;
      scheduleLoadChatsRef.current();
      // If the page is still alive (Android WebView / background tab), also prefetch
      // here — the SW may not have run, or may still be mid-fetch.
      const run = async () => {
        if (kind === 'message-push') {
          try {
            await prefetchChatInBackground(chatId);
          } catch {
            // ignore — apply whatever the SW already wrote
          }
        }
        return applyBackgroundPrefetchRef.current(chatId);
      };
      void run().then((n) => {
        if (activeChatIdRef.current === chatId) {
          bumpChatSync(chatId);
        } else if (kind === 'message-push') {
          setUnreadCounts((prev) => {
            const next = { ...prev, [chatId]: Math.max(prev[chatId] ?? 0, n > 0 ? n : 1) };
            syncTabBadge(next);
            return next;
          });
        } else if (n > 0) {
          bumpChatSync(chatId);
        }
      });
    };

    const onNativePrefetch = (event: Event) => {
      const chatId = (event as CustomEvent<{ chatId?: string }>).detail?.chatId;
      handlePrefetchSignal(chatId, 'prefetch-ready');
    };
    window.addEventListener('coachman-prefetch-ready', onNativePrefetch);

    if (!('serviceWorker' in navigator)) {
      return () => {
        window.removeEventListener('coachman-prefetch-ready', onNativePrefetch);
      };
    }
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: string;
        chatId?: string | null;
        callId?: string | null;
        fromUserId?: string | null;
      };
      if (data?.type === 'open-chat') {
        navigate({ chatId: data.chatId ?? null, panel: null });
        // Force history pull even when already on this chat (WS was closed in background).
        if (data.chatId) {
          void applyBackgroundPrefetchRef.current(data.chatId).finally(() => {
            setChatSyncTick((n) => n + 1);
          });
        } else {
          setChatSyncTick((n) => n + 1);
        }
        scheduleLoadChatsRef.current();
        return;
      }
      if (data?.type === 'message-push' || data?.type === 'prefetch-ready') {
        handlePrefetchSignal(data.chatId, data.type);
        return;
      }
      if (data?.type === 'incoming-call') {
        if (data.chatId) {
          navigate({ chatId: data.chatId, panel: null });
        }
        if (data.chatId && data.callId) {
          const payload: CallSignal = {
            action: 'invite',
            chatId: data.chatId,
            callId: data.callId,
            fromUserId: data.fromUserId ?? undefined,
          };
          const opts = {
            autoAccept: truthyFlag((data as { autoAccept?: unknown }).autoAccept),
            autoReject: truthyFlag((data as { autoReject?: unknown }).autoReject),
          };
          // SW can deliver before auth/handlers are bound — queue and flush after login.
          if (!authRef.current) {
            queuedPushCallRef.current = { payload, opts };
            if (!opts.autoAccept && !opts.autoReject) {
              savePendingCallInvite({
                chatId: payload.chatId,
                callId: payload.callId,
                fromUserId: payload.fromUserId,
              });
            }
          } else {
            incomingCallFromPushRef.current(payload, opts);
          }
        }
        return;
      }
      if (data?.type === 'call-ended') {
        if (data.callId) {
          clearPendingCallInvite(data.callId);
          markCallDismissed(data.callId);
        } else {
          clearPendingCallInvite();
        }
        if (queuedPushCallRef.current?.payload.callId === data.callId) {
          queuedPushCallRef.current = null;
        }
        endCallFromPushRef.current?.({
          callId: data.callId || '',
          chatId: data.chatId || '',
          fromUserId: data.fromUserId ?? undefined,
        });
        return;
      }
      if (data?.type === 'chat-activity') {
        const chatId = data.chatId;
        if (!chatId || !authRef.current) return;
        if (activeChatIdRef.current === chatId && tabVisibleRef.current) return;
        setUnreadCounts((prev) => {
          const next = { ...prev, [chatId]: Math.max(prev[chatId] ?? 0, 1) };
          syncTabBadge(next);
          return next;
        });
        return;
      }
      if (data?.type === 'push-resubscribe') {
        void syncPushSubscription().catch((e) => console.warn('push resubscribe failed', e));
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('coachman-prefetch-ready', onNativePrefetch);
      navigator.serviceWorker.removeEventListener('message', onMessage);
    };
  }, [navigate, bumpChatSync]);

  // Android FCM / native incoming-call path (same handlers as service-worker push).
  useEffect(() => {
    setNativeCallPushHandler((data) => {
      if (data.type === 'incoming-call') {
        if (data.chatId) {
          navigate({ chatId: data.chatId, panel: null });
        }
        if (data.chatId && data.callId) {
          const payload: CallSignal = {
            action: 'invite',
            chatId: data.chatId,
            callId: data.callId,
            fromUserId: data.fromUserId ?? undefined,
          };
          const opts = {
            autoAccept: truthyFlag(data.autoAccept),
            autoReject: truthyFlag(data.autoReject),
          };
          if (!authRef.current) {
            queuedPushCallRef.current = { payload, opts };
            if (!opts.autoAccept && !opts.autoReject) {
              savePendingCallInvite({
                chatId: payload.chatId,
                callId: payload.callId,
                fromUserId: payload.fromUserId,
              });
            }
          } else {
            incomingCallFromPushRef.current(payload, opts);
          }
        }
        return;
      }
      if (data.type === 'call-ended') {
        if (data.callId) {
          clearPendingCallInvite(data.callId);
          markCallDismissed(data.callId);
          void dismissNativeIncomingCall(data.callId);
        } else {
          clearPendingCallInvite();
        }
        if (queuedPushCallRef.current?.payload.callId === data.callId) {
          queuedPushCallRef.current = null;
        }
        endCallFromPushRef.current?.({
          callId: data.callId || '',
          chatId: data.chatId || '',
          fromUserId: data.fromUserId,
        });
        return;
      }
      if (data.type === 'badge' && data.chatId) {
        if (!authRef.current) return;
        if (activeChatIdRef.current === data.chatId && tabVisibleRef.current) return;
        setUnreadCounts((prev) => {
          const next = { ...prev, [data.chatId!]: Math.max(prev[data.chatId!] ?? 0, 1) };
          syncTabBadge(next);
          return next;
        });
      }
    });
    return () => setNativeCallPushHandler(null);
  }, [navigate]);

  useEffect(() => {
    const syncBadgeOnHide = () => {
      if (!document.hidden || !auth) return;
      syncTabBadge(unreadCountsRef.current);
    };
    document.addEventListener('visibilitychange', syncBadgeOnHide);
    window.addEventListener('pagehide', syncBadgeOnHide);
    return () => {
      document.removeEventListener('visibilitychange', syncBadgeOnHide);
      window.removeEventListener('pagehide', syncBadgeOnHide);
    };
  }, [auth]);

  useEffect(() => {
    if (auth) updateTabBadge(unreadTotal);
    else clearTabBadge();
  }, [auth, unreadTotal]);

  useEffect(() => () => clearTabBadge(), []);

  useEffect(() => {
    if (!auth) return;
    import('./lib/crypto').then(({ exportPrivateKey }) => exportPrivateKey(auth.privateKey).then(setPrivateKeyB64));
  }, [auth]);

  const markChatRead = useCallback(async (
    chatId: string,
    at: number,
    opts?: { force?: boolean },
  ) => {
    if (!auth) return;
    if (document.hidden && !opts?.force) return;
    await setLastReadAt(auth.userId, chatId, at);
    setUnreadCounts((prev) => {
      const next = { ...prev, [chatId]: 0 };
      syncTabBadge(next);
      return next;
    });
  }, [auth]);

  const refreshUnreadCounts = useCallback(async (chatList: Chat[]) => {
    if (!auth) return;
    const counts = await computeUnreadCounts(chatList, auth.userId);
    setUnreadCounts(counts);
    syncTabBadge(counts);
  }, [auth]);

  const loadChatsGenRef = useRef(0);
  const loadChatsTimerRef = useRef<number | undefined>(undefined);

  const loadChats = useCallback(async () => {
    if (!auth) return;
    const gen = ++loadChatsGenRef.current;

    const applyRemote = async () => {
      let remote = await enrichChatsWithPreviews(await api.getChats());
      if (gen !== loadChatsGenRef.current) return;
      if (privateKeyB64) {
        try {
          const distributed = await syncSystemGroupKeys(remote, auth.userId, privateKeyB64);
          if (distributed) {
            remote = await enrichChatsWithPreviews(await api.getChats());
            if (gen !== loadChatsGenRef.current) return;
          }
        } catch {
          // key sync is best-effort
        }
      }
      if (gen !== loadChatsGenRef.current) return;
      // Never paint an empty remote over a non-empty sidebar (transient glitch /
      // partial parse). IDB has the same guard in replaceLocalChatsFromApi.
      if (remote.length === 0 && chatsRef.current.length > 0) {
        return;
      }
      setChats(remote);
      await replaceLocalChatsFromApi(remote, auth.userId);
      if (gen !== loadChatsGenRef.current) return;
      await refreshUnreadCounts(remote);
    };

    // Paint local only when the sidebar is still empty (first open / after logout).
    // Never re-apply the full local list later — stale rows (left/deleted chats)
    // used to flash back in on every prefetch / focus sync.
    if (chatsRef.current.length === 0) {
      try {
        const local = await chatsFromLocalStore();
        if (gen !== loadChatsGenRef.current) return;
        if (local.length) {
          setChats(local);
          void refreshUnreadCounts(local);
        }
      } catch {
        // continue to remote
      }
    }

    // Always try the network — Capacitor Android often lies with navigator.onLine.
    try {
      await applyRemote();
    } catch {
      if (gen !== loadChatsGenRef.current) return;
      if (chatsRef.current.length === 0) {
        try {
          const local = await chatsFromLocalStore();
          if (gen !== loadChatsGenRef.current) return;
          setChats(local);
          void refreshUnreadCounts(local);
        } catch {
          // keep whatever is on screen
        }
      }
    }
  }, [auth, privateKeyB64, refreshUnreadCounts]);

  const scheduleLoadChats = useCallback(() => {
    if (loadChatsTimerRef.current !== undefined) {
      window.clearTimeout(loadChatsTimerRef.current);
    }
    loadChatsTimerRef.current = window.setTimeout(() => {
      loadChatsTimerRef.current = undefined;
      void loadChats();
    }, 450);
  }, [loadChats]);
  scheduleLoadChatsRef.current = scheduleLoadChats;

  const touchChatActivity = useCallback(async (chatId: string) => {
    const messages = await getMessages(chatId);
    const latest = messages
      .filter((m) => !m.pending)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!latest) return;
    setChats((prev) => {
      const idx = prev.findIndex((c) => c.id === chatId);
      if (idx < 0) return prev;
      const chat = prev[idx];
      if (
        chat.lastMessage?.id === latest.id &&
        chat.lastMessagePreview === messagePreview(latest)
      ) {
        return prev;
      }
      const next = [...prev];
      next[idx] = {
        ...chat,
        lastMessage: {
          id: latest.id,
          senderId: latest.senderId,
          type: latest.type,
          createdAt: latest.createdAt,
        },
        lastMessagePreview: messagePreview(latest),
      };
      return next;
    });
  }, []);

  useEffect(() => {
    setOutboxAuthRetry(refreshSession);
    return () => setOutboxAuthRetry(undefined);
  }, [refreshSession]);

  // Repair orphan pending bubbles (no outbox row). Do not wipe the live queue.
  useEffect(() => {
    if (!auth) return;
    void (async () => {
      await purgeStuckOutboxOnce();
      const orphans = await failOrphanPendingMessages();
      if (orphans > 0) {
        notify.info('Сброшены зависшие неотправленные сообщения');
        if (activeChatIdRef.current) bumpChatSync(activeChatIdRef.current);
      }
    })();
  }, [auth?.userId, bumpChatSync]);

  useEffect(() => {
    setOutboxErrorReporter((info) => {
      const what = info.kind === 'image' ? 'фото' : 'сообщение';
      if (info.willRetry) {
        notify.warning(`Не удалось отправить ${what}: ${info.message}. Пробую ещё раз…`);
      } else {
        notify.error(`Не удалось отправить ${what}: ${info.message}`);
      }
    });
    return () => setOutboxErrorReporter(undefined);
  }, []);

  const runOutboxFlush = useCallback(async (force = false) => {
    if (!auth) return 0;
    const onSent = (msg: RawMessage) => {
      setChats((prev) =>
        prev.map((c) =>
          c.id === msg.chatId
            ? { ...c, lastMessage: { id: msg.id, senderId: msg.senderId, type: msg.type, createdAt: msg.createdAt } }
            : c,
        ),
      );
    };
    const sent = await flushOutbox({ onSent, onAuthRetry: refreshSession, force });
    if (sent > 0) {
      scheduleLoadChats();
    }
    return sent;
  }, [auth, scheduleLoadChats, refreshSession]);

  useEffect(() => {
    if (!auth) return;
    const onFlushed = () => {
      scheduleLoadChats();
    };
    window.addEventListener(OUTBOX_FLUSHED_EVENT, onFlushed);
    return () => window.removeEventListener(OUTBOX_FLUSHED_EVENT, onFlushed);
  }, [auth, scheduleLoadChats]);

  useEffect(() => {
    if (!auth) return;

    const syncOnline = async () => {
      void refreshSession();
      // Explicit signal (initial load / network back) — bypass retry backoff.
      await runOutboxFlush(true);
      if (privateKeyB64) {
        const map = new Map(chatsRef.current.map((c) => [c.id, c]));
        await flushListOutbox(map, auth.userId, privateKeyB64);
      }
      await loadChats();
    };

    const on = () => {
      if (!onlineRef.current) {
        notify.success('Соединение восстановлено');
      }
      onlineRef.current = true;
      setOnline(true);
      void syncOnline();
    };
    const off = () => {
      if (onlineRef.current) {
        notify.warning('Нет интернета. Сообщения будут отправлены, когда сеть появится.');
      }
      onlineRef.current = false;
      setOnline(false);
      void loadChats();
    };

    void syncOnline();

    const onResume = () => {
      tabVisibleRef.current = !document.hidden;
      if (document.hidden) return;
      scheduleLoadChats();
      // Deferred: don't compete with first paint / chat list load.
      window.setTimeout(() => {
        if (document.hidden) return;
        void (async () => {
          const ids = await listPrefetchChatIds();
          for (const id of ids) {
            await applyBackgroundPrefetchRef.current(id);
          }
          if (activeChatIdRef.current) bumpChatSync(activeChatIdRef.current);
        })();
      }, 600);
      // Always probe outbox — Safari often flaps navigator.onLine. Resume is an
      // explicit user signal, so bypass backoff.
      void runOutboxFlush(true);
    };

    const interval = window.setInterval(() => {
      if (isOutboxCoolingDown()) return;
      void hasOutboxItems().then((pending) => {
        if (pending && !isOutboxCoolingDown()) void runOutboxFlush();
      });
    }, 5000);

    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    window.addEventListener('focus', onResume);
    window.addEventListener('pageshow', onResume);
    document.addEventListener('visibilitychange', onResume);
    return () => {
      window.clearInterval(interval);
      if (loadChatsTimerRef.current !== undefined) {
        window.clearTimeout(loadChatsTimerRef.current);
      }
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      window.removeEventListener('focus', onResume);
      window.removeEventListener('pageshow', onResume);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, [auth, privateKeyB64, refreshSession, runOutboxFlush, loadChats, scheduleLoadChats, bumpChatSync]);

  useEffect(() => {
    void loadChats();
  }, [loadChats]);

  useEffect(() => {
    if (!auth) return;
    const params = new URLSearchParams(window.location.search);
    if (params.has('invite') || params.has('bootstrap')) {
      navigate(route, { replace: true });
    }
  }, [auth]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!auth || !route.chatId || chats.length === 0) return;
    if (!chats.some((c) => c.id === route.chatId)) {
      navigate({ chatId: null, panel: route.panel }, { replace: true });
    }
  }, [auth, route, chats, navigate]);

  useEffect(() => {
    if (!auth || !route.chatId || document.hidden) return;
    const chat = chats.find((c) => c.id === route.chatId);
    if (!chat) return;
    markChatRead(route.chatId, chat.lastMessage?.createdAt ?? Date.now());
  }, [auth, route.chatId, chats, markChatRead]);

  const handleIncoming = useCallback(
    async (payload: unknown) => {
      const msg = payload as RawMessage;
      if (!auth || !privateKeyB64) return;

      let chat = chats.find((c) => c.id === msg.chatId);
      if (!chat) {
        try {
          const fresh = await enrichChatsWithPreviews(await api.getChats());
          if (!(fresh.length === 0 && chatsRef.current.length > 0)) {
            setChats(fresh);
            await replaceLocalChatsFromApi(fresh, auth.userId);
          }
          chat = (fresh.length ? fresh : chatsRef.current).find((c) => c.id === msg.chatId);
        } catch {
          return;
        }
        if (!chat) return;
      }

      if (msg.senderId === auth.userId) return;

      const usernames = new Map(chat.members.map((m) => [m.id, m.username]));
      try {
        const { text, imageUrl } = await decryptMessage(msg, chat, auth.userId, privateKeyB64, usernames);
        // Persist even when image bytes are still loading / decrypt is pending a retry.
        // Only skip a hard permanent decrypt failure for non-image payloads.
        if (msg.type !== 'image' && text === '[не удалось расшифровать]') {
          bumpChatSync(msg.chatId);
          return;
        }
        const stored: StoredMessage = {
          id: msg.id,
          chatId: msg.chatId,
          senderId: msg.senderId,
          senderName: usernames.get(msg.senderId) || '?',
          text: text === '[не удалось расшифровать]' ? '…' : text,
          type: msg.type,
          imageId: msg.imageId,
          albumId: msg.albumId,
          imageUrl,
          createdAt: msg.createdAt,
        };
        await saveMessage(stored);
        if (activeChatIdRef.current === msg.chatId) {
          const [hydrated] = await hydrateStoredMessages([stored]);
          setLiveMessage(hydrated);
          // Image may hydrate without URL on first try — reload history shortly.
          if (msg.type === 'image' && !hydrated.imageUrl) {
            bumpChatSync(msg.chatId);
          }
        }
        setChats((prev) =>
          prev.map((c) =>
            c.id === msg.chatId
              ? {
                  ...c,
                  lastMessage: {
                    id: msg.id,
                    senderId: msg.senderId,
                    type: msg.type,
                    createdAt: msg.createdAt,
                  },
                  lastMessagePreview: messagePreview(stored),
                }
              : c
          )
        );
        if (activeChatIdRef.current === msg.chatId && tabVisibleRef.current) {
          await markChatRead(msg.chatId, msg.createdAt);
        } else {
          setUnreadCounts((prev) => {
            const next = { ...prev, [msg.chatId]: (prev[msg.chatId] ?? 0) + 1 };
            syncTabBadge(next);
            return next;
          });
        }
      } catch {
        bumpChatSync(msg.chatId);
      }
    },
    [auth, privateKeyB64, chats, markChatRead, bumpChatSync]
  );

  const handleMembersChanged = useCallback(
    async (payload: unknown) => {
      const { chatId, userId: affectedUserId, rekeyEpoch, action } = payload as {
        chatId: string;
        userId?: string;
        rekeyEpoch?: number;
        action?: string;
      };
      if (!chatId) return;

      // Only drop local membership when the chat is gone or *we* were removed.
      // Do NOT treat action=added (userId=me) as leave — that wiped the chat
      // (and group key) right after joining and broke send/receive.
      const chatDeleted = action === 'deleted';
      const iWasRemoved = action === 'removed' && !!affectedUserId && affectedUserId === auth?.userId;
      if (chatDeleted || iWasRemoved) {
        if (auth?.userId) await deleteGroupKey(auth.userId, chatId);
        await deleteChatLocal(chatId, auth?.userId);
        setChats((prev) => removeChatFromList(prev, chatId));
        setUnreadCounts((prev) => {
          if (!prev[chatId]) return prev;
          const next = { ...prev };
          delete next[chatId];
          syncTabBadge(next);
          return next;
        });
        if (route.chatId === chatId) {
          navigate({ chatId: null, panel: null });
        }
        return;
      }

      if (auth?.userId && rekeyEpoch) {
        await deleteGroupKey(auth.userId, chatId);
      }
      await loadChats();
    },
    [auth, loadChats, navigate, route.chatId],
  );

  const handleReadReceipt = useCallback(
    async (payload: unknown) => {
      const data = payload as { chatId: string; userId: string; lastReadAt: number };
      if (!auth || data.userId === auth.userId || !data.chatId || !data.lastReadAt) return;

      await updateChatPeerReadAt(data.chatId, data.lastReadAt);
      setChats((prev) =>
        prev.map((c) =>
          c.id === data.chatId && c.type === 'direct'
            ? { ...c, peerLastReadAt: Math.max(c.peerLastReadAt ?? 0, data.lastReadAt) }
            : c,
        ),
      );
    },
    [auth],
  );

  const handlePresence = useCallback(
    (payload: unknown) => {
      const data = payload as { userId: string; online: boolean; lastSeenAt?: number };
      if (!auth || !data.userId || data.userId === auth.userId) return;
      setChats((prev) => {
        let changed = false;
        const next = prev.map((c) => {
          let membersChanged = false;
          const members = c.members.map((m) => {
            if (m.id !== data.userId) return m;
            const lastSeenAt = data.online ? m.lastSeenAt : (data.lastSeenAt ?? m.lastSeenAt);
            if (m.online === data.online && m.lastSeenAt === lastSeenAt) return m;
            membersChanged = true;
            return { ...m, online: data.online, lastSeenAt };
          });
          if (!membersChanged) return c;
          changed = true;
          return { ...c, members };
        });
        return changed ? next : prev;
      });
    },
    [auth],
  );

  const handleTyping = useCallback(
    (payload: unknown) => {
      const data = payload as { chatId: string; userId: string; isTyping: boolean };
      if (!auth || !data.chatId || !data.userId || data.userId === auth.userId) return;

      const prevTimer = typingClearTimers.current[data.chatId];
      if (prevTimer !== undefined) window.clearTimeout(prevTimer);

      if (!data.isTyping) {
        setTypingByChat((prev) => {
          if (prev[data.chatId] !== data.userId) return prev;
          const next = { ...prev };
          delete next[data.chatId];
          return next;
        });
        return;
      }

      setTypingByChat((prev) => ({ ...prev, [data.chatId]: data.userId }));
      typingClearTimers.current[data.chatId] = window.setTimeout(() => {
        setTypingByChat((prev) => {
          if (prev[data.chatId] !== data.userId) return prev;
          const next = { ...prev };
          delete next[data.chatId];
          return next;
        });
        delete typingClearTimers.current[data.chatId];
      }, 4000);
    },
    [auth],
  );

  const handleMessageDeleted = useCallback(async (payload: unknown) => {
    const { chatId, messageId } = payload as { chatId: string; messageId: string };
    if (!chatId || !messageId) return;
    await deleteMessageLocal(messageId, chatId);
    setDeletedMessage({ chatId, messageId });
    scheduleLoadChats();
  }, [scheduleLoadChats]);

  const handleChatCleared = useCallback(async (payload: unknown) => {
    const { chatId } = payload as { chatId: string };
    if (!chatId) return;
    // Keep unsent outbox ciphertext; restore pending bubbles for this chat.
    await clearChatMessagesLocal(chatId, {
      reinstateUserId: authRef.current?.userId,
    });
    setDeletedMessage({ chatId, messageId: '*' });
    setLiveMessage(null);
    setUnreadCounts((prev) => {
      if (!prev[chatId]) return prev;
      const next = { ...prev };
      delete next[chatId];
      syncTabBadge(next);
      return next;
    });
    scheduleLoadChats();
    void runOutboxFlush();
  }, [scheduleLoadChats, runOutboxFlush]);

  const handleChatList = useCallback((payload: unknown) => {
    const data = payload as ChatListEvent;
    if (!data?.chatId || !data.action) return;
    chatListSeqRef.current += 1;
    setChatListEvent({ ...data, seq: chatListSeqRef.current });

    const actor = listEventActorId(data);
    if (auth && actor && actor === auth.userId) return;
    setListUnreadByChat((prev) => {
      if (prev[data.chatId]) return prev;
      return { ...prev, [data.chatId]: true };
    });
    void markListUnread(data.chatId);
  }, [auth]);

  const setChatListUnread = useCallback((chatId: string, unread: boolean) => {
    setListUnreadByChat((prev) => {
      if (!!prev[chatId] === unread) return prev;
      if (!unread) {
        if (!prev[chatId]) return prev;
        const next = { ...prev };
        delete next[chatId];
        return next;
      }
      return { ...prev, [chatId]: true };
    });
  }, []);

  const handleClearChat = useCallback(async (chat: Chat) => {
    if (!auth) return;
    if (!window.confirm(`Очистить историю чата «${chat.displayName}»? Сообщения будут удалены у всех участников.`)) {
      return;
    }

    // Deliver anything pending first so "clear" doesn't silently discard unsent.
    try {
      await runOutboxFlush();
    } catch {
      // continue — user asked to clear
    }

    try {
      await api.clearChat(chat.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Не удалось очистить чат';
      notify.error(message);
      return;
    }

    await clearChatMessagesLocal(chat.id, { dropOutbox: true });
    setDeletedMessage({ chatId: chat.id, messageId: '*' });
    setLiveMessage(null);
    notify.success('Чат очищен');
    await loadChats();
  }, [auth, loadChats, runOutboxFlush]);

  const handleChatMembersUpdated = useCallback(
    async (left?: boolean) => {
      if (left && activeChatId) {
        if (auth?.userId) await deleteGroupKey(auth.userId, activeChatId);
        await deleteChatLocal(activeChatId, auth?.userId);
        setChats((prev) => removeChatFromList(prev, activeChatId));
        navigate({ chatId: null, panel: null });
        return;
      }
      await loadChats();
    },
    [activeChatId, auth?.userId, loadChats, navigate],
  );

  const applyLocalSystemMessage = useCallback((msg: StoredMessage) => {
    setLiveMessage(msg);
    setChats((prev) =>
      prev.map((c) =>
        c.id === msg.chatId
          ? {
              ...c,
              lastMessage: {
                id: msg.id,
                senderId: msg.senderId,
                type: msg.type,
                createdAt: msg.createdAt,
              },
              lastMessagePreview: messagePreview(msg),
            }
          : c,
      ),
    );
  }, []);

  const handleCallEvent = useCallback(
    (event: CallEventReport) => {
      if (!auth || !privateKeyB64) return;
      const chat = chatsRef.current.find((c) => c.id === event.chatId);
      if (!chat) return;
      void postCallEventMessage({
        event,
        chat,
        userId: auth.userId,
        username: auth.username,
        privateKeyB64,
        onLocalMessage: applyLocalSystemMessage,
      }).catch(() => {
        // best-effort chat marker
      });
    },
    [auth, privateKeyB64, applyLocalSystemMessage],
  );

  const handleListSystemMessage = useCallback((msg: StoredMessage) => {
    applyLocalSystemMessage(msg);
  }, [applyLocalSystemMessage]);

  const videoCall = useVideoCall(
    auth?.userId,
    (signal) => {
      sendCallRef.current(signal);
    },
    handleCallEvent,
  );
  const callPhaseRef = useRef(videoCall.phase);
  callPhaseRef.current = videoCall.phase;

  useEffect(() => {
      // FGS camera|microphone requires runtime perms — only after local media is up.
      const mediaActive =
        videoCall.phase === 'outgoing' ||
        videoCall.phase === 'connecting' ||
        videoCall.phase === 'active';
      void setNativeInCallSession(mediaActive, { peerName: videoCall.peerName });
      // Drop ringing UI once connecting/active, or clear suppress when idle.
      if (videoCall.phase === 'connecting' || videoCall.phase === 'active') {
        void dismissNativeIncomingCall(videoCall.callId);
      } else if (videoCall.phase === 'idle') {
        void dismissNativeIncomingCall(null);
      }
    }, [videoCall.phase, videoCall.peerName, videoCall.callId]);

  // Android: ringing uses native full-screen UI only (avoid WebView incoming overlay flash).
  // Never re-present after Accept — that covers MainActivity and breaks getUserMedia.
  useEffect(() => {
    if (!isNativeAndroid()) return;
    if (videoCall.phase !== 'incoming' || !videoCall.callId || !videoCall.chatId) return;
    void CoachmanCalls.showIncomingCall({
      callId: videoCall.callId,
      chatId: videoCall.chatId,
      fromUserId: videoCall.peerUserId ?? undefined,
      title: 'Входящий видеозвонок',
      body: videoCall.peerName || 'Собеседник',
    }).catch(() => {});
  }, [
    videoCall.phase,
    videoCall.callId,
    videoCall.chatId,
    videoCall.peerUserId,
    videoCall.peerName,
  ]);

  const handleCallSignal = useCallback(
    (payload: CallSignal) => {
      if (payload.action === 'invite') {
        const chat = chatsRef.current.find((c) => c.id === payload.chatId);
        const peer = chat?.members.find((m) => m.id === payload.fromUserId);
        videoCall.setPeerName(peer?.username || chat?.displayName || 'Собеседник');
        if (payload.chatId) {
          navigate({ chatId: payload.chatId, panel: null });
        }
      }
      void videoCall.handleSignal(payload);
    },
    // Intentionally depend on stable callbacks from the hook instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [navigate, videoCall.handleSignal, videoCall.setPeerName],
  );

  incomingCallFromPushRef.current = (payload, opts) => {
    if (opts?.autoReject) {
      // Decline must stop the caller even if ring UI never mounted.
      markCallDismissed(payload.callId);
      clearPendingCallInvite(payload.callId);
      sendCallRef.current({
        chatId: payload.chatId,
        callId: payload.callId,
        action: 'reject',
      });
      videoCall.rejectCall();
      return;
    }
    if (opts?.autoAccept) {
      // Skip web incoming entirely — native Accept already happened.
      clearPendingCallInvite(payload.callId);
      void dismissNativeIncomingCall(payload.callId);
      if (payload.chatId) {
        navigate({ chatId: payload.chatId, panel: null });
      }
      const chat = chatsRef.current.find((c) => c.id === payload.chatId);
      const peer = chat?.members.find((m) => m.id === payload.fromUserId);
      videoCall.setPeerName(peer?.username || chat?.displayName || 'Собеседник');
      void videoCall.acceptFromNative({
        chatId: payload.chatId,
        callId: payload.callId,
        fromUserId: payload.fromUserId,
      });
      return;
    }
    handleCallSignal(payload);
  };

  endCallFromPushRef.current = (payload) => {
    handleCallSignal({
      action: 'hangup',
      chatId: payload.chatId,
      callId: payload.callId,
      fromUserId: payload.fromUserId,
    });
  };

  const consumeCallFromUrl = useCallback(() => {
    if (!authRef.current) return false;
    const params = new URLSearchParams(window.location.search);
    const callId = params.get('call');
    if (!callId) return false;
    const pathMatch = window.location.pathname.match(/^\/c\/([^/]+)$/);
    const chatId =
      route.chatId ??
      (pathMatch ? decodeURIComponent(pathMatch[1]) : null) ??
      params.get('chatId');
    if (!chatId) return false;
    const from = params.get('from') ?? undefined;
    const callAction = params.get('callAction');
    params.delete('call');
    params.delete('from');
    params.delete('callAction');
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash}`;
    window.history.replaceState(window.history.state, '', next);
    incomingCallFromPushRef.current(
      { action: 'invite', chatId, callId, fromUserId: from },
      {
        autoAccept: callAction === 'accept',
        autoReject: callAction === 'decline',
      },
    );
    return true;
  }, [route.chatId]);

  // Flush invite that arrived while locked / still loading auth.
  useEffect(() => {
    if (!auth) return;
    if (consumeCallFromUrl()) return;
    const queued = queuedPushCallRef.current;
    if (queued) {
      queuedPushCallRef.current = null;
      incomingCallFromPushRef.current(queued.payload, queued.opts);
      return;
    }
    // Reopen from icon (not notification): restore ringing UI from session/cache.
    // Never restore while already in a call / connecting.
    if (videoCall.phase !== 'idle') return;
    void loadPendingCallInviteAsync().then((pending) => {
      if (!pending || !authRef.current) return;
      if (callPhaseRef.current !== 'idle') return;
      handleCallSignal({
        action: 'invite',
        chatId: pending.chatId,
        callId: pending.callId,
        fromUserId: pending.fromUserId,
      });
    });
  }, [auth?.userId, consumeCallFromUrl, handleCallSignal, videoCall.phase]);

  // Fill peer label when invite arrived before chats loaded.
  useEffect(() => {
    if (videoCall.phase === 'idle' || !videoCall.chatId) return;
    if (videoCall.peerName && videoCall.peerName !== 'Собеседник') return;
    const chat = chats.find((c) => c.id === videoCall.chatId);
    if (!chat) return;
    const peer = chat.members.find((m) => m.id === videoCall.peerUserId)
      ?? chat.members.find((m) => m.id !== auth?.userId);
    videoCall.setPeerName(peer?.username || chat.displayName || 'Собеседник');
  }, [
    auth?.userId,
    chats,
    videoCall.chatId,
    videoCall.peerName,
    videoCall.peerUserId,
    videoCall.phase,
    videoCall.setPeerName,
  ]);

  // Resume app while a push invite was stored (notification seen, app opened by icon/task).
  useEffect(() => {
    if (!auth) return;
    const onWake = () => {
      if (document.hidden) return;
      if (consumeCallFromUrl()) return;
      void loadPendingCallInviteAsync().then((pending) => {
        if (!pending || !authRef.current) return;
        handleCallSignal({
          action: 'invite',
          chatId: pending.chatId,
          callId: pending.callId,
          fromUserId: pending.fromUserId,
        });
      });
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [auth?.userId, consumeCallFromUrl, handleCallSignal]);

  const { sendTyping, sendCall } = useWebSocket(
    !!auth,
    handleIncoming,
    handleMembersChanged,
    handleReadReceipt,
    handlePresence,
    handleTyping,
    handleMessageDeleted,
    handleCallSignal,
    videoCall.phase !== 'idle',
    handleChatCleared,
    handleChatList,
  );
  sendCallRef.current = sendCall;

  const handleSelectChat = useCallback(async (id: string) => {
    navigate({ chatId: id, panel: null });
    const chat = chats.find((c) => c.id === id);
    await markChatRead(id, chat?.lastMessage?.createdAt ?? Date.now());
  }, [chats, markChatRead, navigate]);

  const handleLogout = async () => {
    // Clear session first so UI exits immediately; push cleanup must not block.
    await logout();
    setChats([]);
    setUnreadCounts({});
    setTypingByChat({});
    setPrivateKeyB64('');
    navigate({ chatId: null, panel: null }, { replace: true });
    void unsubscribeFromPush().catch(() => {});
  };

  const activeChat = chats.find((c) => c.id === activeChatId) ?? null;

  const onActiveListUnreadChange = useCallback(
    (unread: boolean) => {
      if (!activeChatId) return;
      setChatListUnread(activeChatId, unread);
    },
    [activeChatId, setChatListUnread],
  );
  const callPeer =
    videoCall.phase !== 'idle' && videoCall.peerUserId
      ? (chats
          .find((c) => c.id === videoCall.chatId)
          ?.members.find((m) => m.id === videoCall.peerUserId) ??
        chats
          .flatMap((c) => c.members)
          .find((m) => m.id === videoCall.peerUserId) ??
        null)
      : null;
  const listChats = useMemo(
    () => (auth ? visibleChatsForUser(chats, auth.userId, auth.isAdmin) : chats),
    [auth, chats],
  );

  const urlParams = new URLSearchParams(window.location.search);
  const inviteToken = urlParams.get('invite') ?? undefined;
  const bootstrapToken = urlParams.get('bootstrap') ?? undefined;

  if (loading) {
    return <div className="loading">Загрузка...</div>;
  }

  if (!auth) {
    if (lockedAccount) {
      return <UnlockScreen username={lockedAccount.username} onUnlock={unlock} error={error} />;
    }
    return (
      <AuthScreen
        localAccounts={localAccounts}
        inviteToken={inviteToken}
        bootstrapToken={bootstrapToken}
        onRegister={register}
        onLoginLocal={loginLocal}
        onRemoveFromDevice={removeFromDevice}
        error={error}
      />
    );
  }

  return (
    <div className="app">
      <div className={`sidebar ${activeChatId ? 'hidden-mobile' : ''}`}>
        <ChatList
          chats={listChats}
          activeId={activeChatId}
          unreadCounts={unreadCounts}
          onSelect={handleSelectChat}
          onCreateGroup={
            auth.isAdmin
              ? undefined
              : () => navigate({ chatId: route.chatId, panel: 'group' })
          }
          onSettings={() => navigate({ chatId: route.chatId, panel: 'settings' })}
          pushPermission={pushPerm}
          pushNeedsPWAInstall={pushNeedsInstall}
          onEnablePush={() => {
            onEnablePushClick((result) => {
              refreshPushPermission();
              if (result === 'ok') {
                notify.success('Уведомления включены');
                void syncPushSubscription().catch(() => {});
                return;
              }
              if (result === 'denied') {
                notify.warning('Разрешите уведомления: Настройки → Уведомления → Ямщик');
                return;
              }
              if (result === 'no-vapid') {
                void prefetchPushConfig().then(() => {
                  notify.info('Повторите: нажмите «Включить» ещё раз.');
                });
                return;
              }
              if (result === 'needs-install') {
                notify.info('Добавьте Ямщик на экран «Домой» для уведомлений.');
                return;
              }
              if (result === 'unsupported') {
                notify.warning('Push не поддерживается в этом браузере.');
                return;
              }
              notify.warning('Не удалось включить уведомления. Попробуйте ещё раз.');
            });
          }}
          username={auth.username}
          userId={auth.userId}
          hasAvatar={auth.hasAvatar}
          avatarUpdatedAt={auth.avatarUpdatedAt}
          avatarUrl={auth.avatarUrl}
          online={online}
        />
      </div>

      <main className={`main ${!activeChatId ? 'hidden-mobile' : ''}`}>
        {activeChat && privateKeyB64 ? (
          <ChatView
            key={`${activeChat.id}-${activeChat.members.length}-${activeChat.groupKeyEpoch ?? 1}-${activeChat.members.find((m) => m.id === auth.userId)?.encryptedGroupKey ? 'k' : 'nk'}`}
            chat={activeChat}
            userId={auth.userId}
            privateKey={auth.privateKey}
            privateKeyB64={privateKeyB64}
            onBack={() => navigate({ chatId: null, panel: null })}
            onMembersChanged={handleChatMembersUpdated}
            canClearChat={!activeChat.isSystem}
            onClearChat={() => void handleClearChat(activeChat)}
            onRead={(at) => {
              if (!document.hidden) markChatRead(activeChat.id, at);
            }}
            incomingMessage={liveMessage}
            deletedMessage={deletedMessage}
            syncTick={chatSyncTick}
            listEvent={chatListEvent}
            listUnread={!!listUnreadByChat[activeChat.id]}
            onListUnreadChange={onActiveListUnreadChange}
            peerTyping={!!typingByChat[activeChat.id]}
            typingUserId={typingByChat[activeChat.id] ?? null}
            onTypingChange={(isTyping) => sendTyping(activeChat.id, isTyping)}
            onMessagesChanged={() => {
              void touchChatActivity(activeChat.id);
            }}
            onStartVideoCall={
              activeChat.type === 'direct'
                ? () => {
                    const peer = activeChat.members.find((m) => m.id !== auth.userId);
                    void videoCall.startCall({
                      chatId: activeChat.id,
                      peerName: peer?.username || activeChat.displayName,
                      peerUserId: peer?.id,
                    });
                  }
                : undefined
            }
            onListSystemMessage={handleListSystemMessage}
          />
        ) : (
          <div className="empty-state">
            <p>Выберите чат или создайте новый</p>
          </div>
        )}
      </main>

      {videoCall.phase !== 'idle' &&
        !(isNativeAndroid() && videoCall.phase === 'incoming') && (
        <VideoCallOverlay
          phase={videoCall.phase}
          peerName={videoCall.peerName}
          peerUserId={videoCall.peerUserId ?? callPeer?.id}
          peerHasAvatar={callPeer?.hasAvatar}
          peerAvatarUpdatedAt={callPeer?.avatarUpdatedAt}
          peerAvatarUrl={callPeer?.avatarUrl}
          error={videoCall.error}
          connLabel={videoCall.connLabel}
          muted={videoCall.muted}
          cameraOff={videoCall.cameraOff}
          onAccept={() => void videoCall.acceptCall()}
          onReject={videoCall.rejectCall}
          onHangup={videoCall.hangup}
          onToggleMute={videoCall.toggleMute}
          onToggleCamera={videoCall.toggleCamera}
          onSwitchCamera={() => void videoCall.switchCamera()}
          facingMode={videoCall.facingMode}
          localVideoRef={videoCall.attachLocalVideo}
          remoteVideoRef={videoCall.attachRemoteVideo}
        />
      )}

      {route.panel === 'group' && !auth.isAdmin && (
        <CreateGroupModal
          currentUserId={auth.userId}
          privateKey={auth.privateKey}
          publicKey={auth.publicKey}
          onCreated={(id) => {
            loadChats();
            navigate({ chatId: id, panel: null });
            markChatRead(id, Date.now());
          }}
          onClose={() => navigate({ chatId: route.chatId, panel: null })}
        />
      )}

      {route.panel === 'settings' && (
        <SettingsModal
          userId={auth.userId}
          username={auth.username}
          hasAvatar={auth.hasAvatar}
          avatarUpdatedAt={auth.avatarUpdatedAt}
          avatarUrl={auth.avatarUrl}
          isAdmin={auth.isAdmin}
          onInvite={auth.isAdmin ? () => navigate({ chatId: route.chatId, panel: 'invite' }) : undefined}
          onAdminUsers={auth.isAdmin ? () => navigate({ chatId: route.chatId, panel: 'users' }) : undefined}
          onBecameAdmin={() => {
            void markAsAdmin().then(() => loadChats());
          }}
          onAvatarChange={({ hasAvatar, avatarUpdatedAt, avatarUrl }) => {
            updateAvatar(hasAvatar, avatarUpdatedAt, avatarUrl);
            void loadChats();
          }}
          onLogout={() => void handleLogout()}
          onClose={() => navigate({ chatId: route.chatId, panel: null })}
        />
      )}

      {auth.isAdmin && route.panel === 'invite' && (
        <InviteModal onClose={() => navigate({ chatId: route.chatId, panel: null })} />
      )}

      {auth.isAdmin && route.panel === 'users' && (
        <AdminUsersModal
          currentUserId={auth.userId}
          onClose={() => navigate({ chatId: route.chatId, panel: null })}
          onUserDeleted={() => {
            void loadChats();
          }}
        />
      )}
    </div>
  );
}
