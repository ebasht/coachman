import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuth } from './hooks/useAuth';
import { useWebSocket } from './hooks/useWebSocket';
import { notify } from './lib/notify';
import { updateTabBadge, clearTabBadge, syncTabBadge, isTabVisible } from './lib/tab-badge';
import { AuthScreen } from './components/AuthScreen';
import { ChatList } from './components/ChatList';
import { ChatView } from './components/ChatView';
import { NewChatModal } from './components/NewChatModal';
import { CreateGroupModal } from './components/CreateGroupModal';
import { api, type Chat, type User, type RawMessage } from './lib/api';
import { saveChat, getChats, saveMessage, deleteGroupKey, type StoredMessage } from './lib/storage';
import { decryptMessage } from './lib/messages';
import { hydrateStoredMessages } from './lib/image-preview';
import { InviteModal } from './components/InviteModal';
import { InviteGraphModal } from './components/InviteGraphModal';
import { AdminUsersModal } from './components/AdminUsersModal';
import { flushOutbox } from './lib/outbox';
import { UnlockScreen } from './components/UnlockScreen';
import { computeUnreadCounts, setLastReadAt } from './lib/unread';
import { syncPushSubscription, unsubscribeFromPush, onEnablePushClick, prefetchPushConfig } from './lib/push-subscribe';
import { usePushPermission } from './hooks/usePushPermission';
import { useAppRoute } from './hooks/useAppRoute';
import { useVisualViewport } from './hooks/useVisualViewport';

export default function App() {
  useVisualViewport();
  const { auth, lockedAccount, localAccounts, loading, error, register, login, loginLocal, unlock, logout, removeFromDevice, deleteAccountFully, deleteCurrentAccount } = useAuth();
  const { route, navigate } = useAppRoute(!!auth);
  const { permission: pushPerm, needsInstall: pushNeedsInstall, refresh: refreshPushPermission } = usePushPermission();
  const [chats, setChats] = useState<Chat[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const onlineRef = useRef(navigator.onLine);
  const [privateKeyB64, setPrivateKeyB64] = useState('');
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const [liveMessage, setLiveMessage] = useState<StoredMessage | null>(null);
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
      };
      if (data?.type === 'open-chat') {
        navigate({ chatId: data.chatId ?? null, panel: null });
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
    const on = () => {
      if (!onlineRef.current) {
        notify.success('Соединение восстановлено');
      }
      onlineRef.current = true;
      setOnline(true);
    };
    const off = () => {
      if (onlineRef.current) {
        notify.warning('Нет интернета. Сообщения будут отправлены, когда сеть появится.');
      }
      onlineRef.current = false;
      setOnline(false);
    };
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  useEffect(() => {
    if (!auth) return;
    const flush = () => {
      flushOutbox((msg) => {
        setChats((prev) =>
          prev.map((c) =>
            c.id === msg.chatId
              ? { ...c, lastMessage: { id: msg.id, senderId: msg.senderId, type: msg.type, createdAt: msg.createdAt } }
              : c,
          ),
        );
      });
    };
    flush();
    const onResume = () => {
      if (!document.hidden) flush();
    };
    window.addEventListener('online', flush);
    document.addEventListener('visibilitychange', onResume);
    return () => {
      window.removeEventListener('online', flush);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, [auth]);

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

    const cached = await getChats();
    if (cached.length) {
      setChats(
        cached.map((c) => ({
          id: c.id,
          type: c.type,
          name: c.type === 'group' ? c.displayName : null,
          displayName: c.displayName,
          members: c.members,
          lastMessage: null,
          createdAt: 0,
        }))
      );
    }

    try {
      const remote = await api.getChats();
      setChats(remote);
      for (const c of remote) {
        await saveChat({
          id: c.id,
          type: c.type,
          displayName: c.displayName,
          members: c.members,
          lastMessageAt: c.lastMessage?.createdAt,
        });
      }
      await refreshUnreadCounts(remote);
    } catch {
      // offline
    }
  }, [auth, refreshUnreadCounts]);

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
    loadChats();
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
          const fresh = await api.getChats();
          setChats(fresh);
          for (const c of fresh) {
            await saveChat({
              id: c.id,
              type: c.type,
              displayName: c.displayName,
              members: c.members,
              lastMessageAt: c.lastMessage?.createdAt,
            });
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

  useWebSocket(!!auth, handleIncoming, handleMembersChanged);

  const handleSelectChat = useCallback(async (id: string) => {
    navigate({ chatId: id, panel: null });
    const chat = chats.find((c) => c.id === id);
    await markChatRead(id, chat?.lastMessage?.createdAt ?? Date.now());
  }, [chats, markChatRead, navigate]);

  const startDirectChat = async (user: User) => {
    if (!auth) return;
    const { id } = await api.createDirectChat(user.id);
    await loadChats();
    navigate({ chatId: id, panel: null });
    await markChatRead(id, Date.now());
  };

  const handleLogout = async () => {
    await unsubscribeFromPush().catch(() => {});
    await logout();
    setChats([]);
    setUnreadCounts({});
    setPrivateKeyB64('');
    navigate({ chatId: null, panel: null }, { replace: true });
  };

  const activeChat = chats.find((c) => c.id === activeChatId) ?? null;

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
        onLogin={login}
        onLoginLocal={loginLocal}
        onRemoveFromDevice={removeFromDevice}
        onDeleteFully={deleteAccountFully}
        error={error}
      />
    );
  }

  return (
    <div className="app">
      <div className={`sidebar ${activeChatId ? 'hidden-mobile' : ''}`}>
        <ChatList
          chats={chats}
          activeId={activeChatId}
          unreadCounts={unreadCounts}
          onSelect={handleSelectChat}
          onNewChat={() => navigate({ chatId: route.chatId, panel: 'new' })}
          onInvite={() => navigate({ chatId: route.chatId, panel: 'invite' })}
          onInviteGraph={auth.isAdmin ? () => navigate({ chatId: route.chatId, panel: 'graph' }) : undefined}
          onAdminUsers={auth.isAdmin ? () => navigate({ chatId: route.chatId, panel: 'users' }) : undefined}
          onLogout={handleLogout}
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
          onDeleteAccount={async () => {
            if (window.confirm('Удалить аккаунт полностью? Все данные на сервере будут удалены.')) {
              await deleteCurrentAccount();
              setChats([]);
              setPrivateKeyB64('');
              navigate({ chatId: null, panel: null }, { replace: true });
            }
          }}
          username={auth.username}
          online={online}
        />
      </div>

      <main className={`main ${!activeChatId ? 'hidden-mobile' : ''}`}>
        {activeChat && privateKeyB64 ? (
          <ChatView
            key={`${activeChat.id}-${activeChat.members.length}-${activeChat.groupKeyEpoch ?? 1}`}
            chat={activeChat}
            userId={auth.userId}
            publicKey={auth.publicKey}
            privateKey={auth.privateKey}
            privateKeyB64={privateKeyB64}
            onBack={() => navigate({ chatId: null, panel: null })}
            onMembersChanged={handleChatMembersUpdated}
            onRead={(at) => {
              if (!document.hidden) markChatRead(activeChat.id, at);
            }}
            incomingMessage={liveMessage}
          />
        ) : (
          <div className="empty-state">
            <p>Выберите чат или создайте новый</p>
          </div>
        )}
      </main>

      {route.panel === 'new' && (
        <NewChatModal
          currentUserId={auth.userId}
          onSelectUser={startDirectChat}
          onCreateGroup={() => navigate({ chatId: route.chatId, panel: 'group' })}
          onClose={() => navigate({ chatId: route.chatId, panel: null })}
        />
      )}

      {route.panel === 'group' && (
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

      {route.panel === 'invite' && <InviteModal onClose={() => navigate({ chatId: route.chatId, panel: null })} />}

      {route.panel === 'graph' && <InviteGraphModal onClose={() => navigate({ chatId: route.chatId, panel: null })} />}

      {route.panel === 'users' && (
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
