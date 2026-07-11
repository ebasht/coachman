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
import { saveMessage, deleteGroupKey, clearChatMessagesLocal, deleteMessageLocal, updateChatPeerReadAt, type StoredMessage } from './lib/storage';
import { chatsFromLocalStore, saveChatFromApi, enrichChatsWithPreviews } from './lib/offline-chats';
import { decryptMessage } from './lib/messages';
import { hydrateStoredMessages } from './lib/image-preview';
import { InviteModal } from './components/InviteModal';
import { AdminUsersModal } from './components/AdminUsersModal';
import { SettingsModal } from './components/SettingsModal';
import { findAdminDirectChat, isAdminSupportChat, visibleChatsForUser } from './lib/admin-chat';
import { syncSystemGroupKeys } from './lib/system-group';
import { flushOutbox, hasOutboxItems, setOutboxAuthRetry, OUTBOX_FLUSHED_EVENT } from './lib/outbox';
import { flushListOutbox } from './lib/list-sync';
import { UnlockScreen } from './components/UnlockScreen';
import { computeUnreadCounts, setLastReadAt } from './lib/unread';
import { syncPushSubscription, unsubscribeFromPush, onEnablePushClick, prefetchPushConfig } from './lib/push-subscribe';
import { usePushPermission } from './hooks/usePushPermission';
import { useAppRoute } from './hooks/useAppRoute';
import { useVisualViewport } from './hooks/useVisualViewport';
import { useVideoCall } from './hooks/useVideoCall';
import { VideoCallOverlay } from './components/VideoCallOverlay';
import type { CallSignal } from './lib/call-types';
import type { ChatListEvent } from './components/ChatListsModal';

export default function App() {
  useVisualViewport();
  const { auth, lockedAccount, localAccounts, loading, error, register, loginLocal, unlock, logout, removeFromDevice, refreshSession, updateAvatar } = useAuth();
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
  const [typingByChat, setTypingByChat] = useState<Record<string, string>>({});
  const sendCallRef = useRef<(signal: Omit<CallSignal, 'fromUserId'>) => void>(() => {});
  const incomingCallFromPushRef = useRef<
    (payload: CallSignal, opts?: { autoAccept?: boolean; autoReject?: boolean }) => void
  >(() => {});
  const chatsRef = useRef(chats);
  chatsRef.current = chats;
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
    };
    resetBadge();
    document.addEventListener('visibilitychange', resetBadge);
    window.addEventListener('focus', resetBadge);
    return () => {
      document.removeEventListener('visibilitychange', resetBadge);
      window.removeEventListener('focus', resetBadge);
    };
  }, [auth?.userId]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: string;
        chatId?: string | null;
        callId?: string | null;
        fromUserId?: string | null;
      };
      if (data?.type === 'open-chat') {
        navigate({ chatId: data.chatId ?? null, panel: null });
        return;
      }
      if (data?.type === 'incoming-call') {
        if (data.chatId) {
          navigate({ chatId: data.chatId, panel: null });
        }
        if (data.chatId && data.callId) {
          incomingCallFromPushRef.current(
            {
              action: 'invite',
              chatId: data.chatId,
              callId: data.callId,
              fromUserId: data.fromUserId ?? undefined,
            },
            {
              autoAccept: !!(data as { autoAccept?: boolean }).autoAccept,
              autoReject: !!(data as { autoReject?: boolean }).autoReject,
            },
          );
        }
        return;
      }
      if (data?.type === 'push-resubscribe') {
        void syncPushSubscription().catch((e) => console.warn('push resubscribe failed', e));
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
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

  const loadChats = useCallback(async () => {
    if (!auth) return;

    try {
      const local = await chatsFromLocalStore();
      setChats(local);
      void refreshUnreadCounts(local);
    } catch {
      return;
    }

    if (!navigator.onLine) return;

    void (async () => {
      try {
        let remote = await enrichChatsWithPreviews(await api.getChats());
        if (privateKeyB64) {
          try {
            const distributed = await syncSystemGroupKeys(remote, auth.userId, privateKeyB64);
            if (distributed) {
              remote = await enrichChatsWithPreviews(await api.getChats());
            }
          } catch {
            // key sync is best-effort
          }
        }
        setChats(remote);
        for (const c of remote) {
          await saveChatFromApi(c);
        }
        await refreshUnreadCounts(remote);
      } catch {
        // keep local list already on screen
      }
    })();
  }, [auth, privateKeyB64, refreshUnreadCounts]);

  useEffect(() => {
    setOutboxAuthRetry(refreshSession);
    return () => setOutboxAuthRetry(undefined);
  }, [refreshSession]);

  const runOutboxFlush = useCallback(async () => {
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
    const sent = await flushOutbox({ onSent, onAuthRetry: refreshSession });
    if (sent > 0) {
      await loadChats();
    }
    return sent;
  }, [auth, loadChats, refreshSession]);

  useEffect(() => {
    if (!auth) return;
    const onFlushed = () => {
      void loadChats();
    };
    window.addEventListener(OUTBOX_FLUSHED_EVENT, onFlushed);
    return () => window.removeEventListener(OUTBOX_FLUSHED_EVENT, onFlushed);
  }, [auth, loadChats]);

  useEffect(() => {
    if (!auth) return;

    const syncOnline = async () => {
      void refreshSession();
      await loadChats();
      await runOutboxFlush();
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
    };

    void syncOnline();

    const onResume = () => {
      if (!document.hidden && navigator.onLine) void syncOnline();
    };

    const interval = window.setInterval(() => {
      if (!navigator.onLine) return;
      void hasOutboxItems().then((pending) => {
        if (pending) void syncOnline();
      });
    }, 3000);

    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    window.addEventListener('focus', onResume);
    window.addEventListener('pageshow', onResume);
    document.addEventListener('visibilitychange', onResume);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      window.removeEventListener('focus', onResume);
      window.removeEventListener('pageshow', onResume);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, [auth, privateKeyB64, refreshSession, runOutboxFlush, loadChats]);

  useEffect(() => {
    if (!auth) return;
    const onOffline = () => {
      void loadChats();
    };
    window.addEventListener('offline', onOffline);
    return () => window.removeEventListener('offline', onOffline);
  }, [auth, loadChats]);

  useEffect(() => {
    loadChats();
  }, [loadChats]);

  useEffect(() => {
    if (!auth) return;
    const onResume = () => {
      tabVisibleRef.current = !document.hidden;
      if (document.hidden) return;
      void loadChats();
    };
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('focus', onResume);
    window.addEventListener('pageshow', onResume);
    return () => {
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('focus', onResume);
      window.removeEventListener('pageshow', onResume);
    };
  }, [auth, loadChats]);

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
        const local = await chatsFromLocalStore();
        chat = local.find((c) => c.id === msg.chatId);
        if (chat) setChats(local);
      }
      if (!chat) {
        try {
          const fresh = await api.getChats();
          setChats(fresh);
          for (const c of fresh) {
            await saveChatFromApi(c);
          }
          chat = fresh.find((c) => c.id === msg.chatId);
        } catch {
          return;
        }
        if (!chat) return;
      }

      if (msg.senderId === auth.userId) return;

      const usernames = new Map(chat.members.map((m) => [m.id, m.username]));
      try {
        const { text, imageUrl } = await decryptMessage(msg, chat, auth.userId, privateKeyB64, usernames);
        if (text === '[не удалось расшифровать]' || text.includes('[не удалось')) {
          return;
        }
        const stored: StoredMessage = {
          id: msg.id,
          chatId: msg.chatId,
          senderId: msg.senderId,
          senderName: usernames.get(msg.senderId) || '?',
          text,
          type: msg.type,
          imageId: msg.imageId,
          imageUrl,
          createdAt: msg.createdAt,
        };
        await saveMessage(stored);
        if (activeChatIdRef.current === msg.chatId) {
          const [hydrated] = await hydrateStoredMessages([stored]);
          setLiveMessage(hydrated);
        }
        setChats((prev) =>
          prev.map((c) =>
            c.id === msg.chatId
              ? { ...c, lastMessage: { id: msg.id, senderId: msg.senderId, type: msg.type, createdAt: msg.createdAt } }
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
        // decryption failed
      }
    },
    [auth, privateKeyB64, chats, markChatRead]
  );

  const handleMembersChanged = useCallback(
    async (payload: unknown) => {
      const { chatId, userId: affectedUserId, rekeyEpoch, action } = payload as {
        chatId: string;
        userId?: string;
        rekeyEpoch?: number;
        action?: string;
      };
      if (action === 'deleted' || affectedUserId === auth?.userId || rekeyEpoch) {
        await deleteGroupKey(chatId);
      }
      await loadChats();
      if ((action === 'deleted' || affectedUserId === auth?.userId) && route.chatId === chatId) {
        navigate({ chatId: null, panel: null });
      }
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
      setChats((prev) =>
        prev.map((c) => ({
          ...c,
          members: c.members.map((m) =>
            m.id === data.userId
              ? {
                  ...m,
                  online: data.online,
                  lastSeenAt: data.online ? m.lastSeenAt : (data.lastSeenAt ?? m.lastSeenAt),
                }
              : m,
          ),
        })),
      );
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
    void loadChats();
  }, [loadChats]);

  const handleChatCleared = useCallback(async (payload: unknown) => {
    const { chatId } = payload as { chatId: string };
    if (!chatId) return;
    await clearChatMessagesLocal(chatId);
    setDeletedMessage({ chatId, messageId: '*' });
    setLiveMessage(null);
    setUnreadCounts((prev) => {
      if (!prev[chatId]) return prev;
      const next = { ...prev };
      delete next[chatId];
      syncTabBadge(next);
      return next;
    });
    void loadChats();
  }, [loadChats]);

  const handleChatList = useCallback((payload: unknown) => {
    const data = payload as ChatListEvent;
    if (!data?.chatId || !data.action) return;
    chatListSeqRef.current += 1;
    setChatListEvent({ ...data, seq: chatListSeqRef.current });
  }, []);

  const handleClearChat = useCallback(async (chat: Chat) => {
    if (!auth) return;
    if (!window.confirm(`Очистить историю чата «${chat.displayName}»? Сообщения будут удалены у всех участников.`)) {
      return;
    }

    try {
      await api.clearChat(chat.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Не удалось очистить чат';
      notify.error(message);
      return;
    }

    await clearChatMessagesLocal(chat.id);
    setDeletedMessage({ chatId: chat.id, messageId: '*' });
    setLiveMessage(null);
    notify.success('Чат очищен');
    await loadChats();
  }, [auth, loadChats]);

  const handleChatMembersUpdated = useCallback(
    async (left?: boolean) => {
      if (left && activeChatId) {
        await deleteGroupKey(activeChatId);
        navigate({ chatId: null, panel: null });
      }
      await loadChats();
    },
    [activeChatId, loadChats, navigate],
  );

  const videoCall = useVideoCall(auth?.userId, (signal) => {
    sendCallRef.current(signal);
  });

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
    handleCallSignal(payload);
    if (opts?.autoReject) {
      videoCall.rejectCall();
      return;
    }
    if (opts?.autoAccept) {
      void videoCall.acceptCall();
    }
  };

  // Cold start from call notification (?call=&callAction=).
  useEffect(() => {
    if (!auth) return;
    const params = new URLSearchParams(window.location.search);
    const callId = params.get('call');
    const chatId = route.chatId ?? params.get('chatId');
    const from = params.get('from') ?? undefined;
    const callAction = params.get('callAction');
    if (!callId || !chatId) return;
    params.delete('call');
    params.delete('from');
    params.delete('callAction');
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash}`;
    window.history.replaceState(null, '', next);
    incomingCallFromPushRef.current(
      { action: 'invite', chatId, callId, fromUserId: from },
      {
        autoAccept: callAction === 'accept',
        autoReject: callAction === 'decline',
      },
    );
  }, [auth?.userId, route.chatId]);

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

  const openAdminChat = useCallback(async () => {
    if (!auth || auth.isAdmin) return;
    const existing = findAdminDirectChat(chats, auth.userId);
    if (existing) {
      navigate({ chatId: existing.id, panel: null });
      await markChatRead(existing.id, existing.lastMessage?.createdAt ?? Date.now());
      return;
    }
    try {
      const circle = await api.getCircle();
      const admin = circle.find((u) => u.isAdmin && u.id !== auth.userId);
      if (!admin) {
        notify.warning('Админ пока недоступен');
        return;
      }
      const { id } = await api.createDirectChat(admin.id);
      await loadChats();
      navigate({ chatId: id, panel: null });
      await markChatRead(id, Date.now());
    } catch (e) {
      notify.error(e instanceof Error ? e.message : 'Не удалось открыть чат с админом');
    }
  }, [auth, chats, loadChats, markChatRead, navigate]);

  const activeChat = chats.find((c) => c.id === activeChatId) ?? null;
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
  const adminChat = useMemo(
    () => (auth && !auth.isAdmin ? findAdminDirectChat(chats, auth.userId) : undefined),
    [auth, chats],
  );
  const adminChatUnread = adminChat ? (unreadCounts[adminChat.id] ?? 0) : 0;

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
          settingsUnread={adminChatUnread}
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
            key={`${activeChat.id}-${activeChat.members.length}-${activeChat.groupKeyEpoch ?? 1}`}
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
            listEvent={chatListEvent}
            peerTyping={!!typingByChat[activeChat.id]}
            typingUserId={typingByChat[activeChat.id] ?? null}
            onTypingChange={(isTyping) => sendTyping(activeChat.id, isTyping)}
            onMessagesChanged={() => {
              void loadChats();
            }}
            onStartVideoCall={
              activeChat.type === 'direct' && !isAdminSupportChat(activeChat)
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
          />
        ) : (
          <div className="empty-state">
            <p>Выберите чат или создайте новый</p>
          </div>
        )}
      </main>

      {videoCall.phase !== 'idle' && (
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
          adminChatUnread={adminChatUnread}
          onOpenAdminChat={auth.isAdmin ? undefined : () => void openAdminChat()}
          onInvite={auth.isAdmin ? () => navigate({ chatId: route.chatId, panel: 'invite' }) : undefined}
          onAdminUsers={auth.isAdmin ? () => navigate({ chatId: route.chatId, panel: 'users' }) : undefined}
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
