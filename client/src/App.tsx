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
import { saveChat, getChats, saveMessage, deleteGroupKey } from './lib/storage';
import { decryptMessage } from './lib/messages';
import { InviteModal } from './components/InviteModal';
import { InviteGraphModal } from './components/InviteGraphModal';
import { flushOutbox } from './lib/outbox';
import { UnlockScreen } from './components/UnlockScreen';
import { computeUnreadCounts, setLastReadAt } from './lib/unread';
import { useAppRoute } from './hooks/useAppRoute';

export default function App() {
  const { auth, lockedAccount, localAccounts, loading, error, register, login, loginLocal, unlock, logout, removeFromDevice, deleteAccountFully, deleteCurrentAccount } = useAuth();
  const { route, navigate } = useAppRoute(!!auth);
  const [chats, setChats] = useState<Chat[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const onlineRef = useRef(navigator.onLine);
  const [privateKeyB64, setPrivateKeyB64] = useState('');
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});
  const unreadTotal = useMemo(
    () => Object.values(unreadCounts).reduce((sum, count) => sum + count, 0),
    [unreadCounts],
  );
  const activeChatId = route.chatId;
  const activeChatIdRef = useRef<string | null>(null);
  const tabVisibleRef = useRef(isTabVisible());
  activeChatIdRef.current = activeChatId;

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
    window.addEventListener('online', flush);
    return () => window.removeEventListener('online', flush);
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

  useEffect(() => {
    const onVisibility = () => {
      tabVisibleRef.current = isTabVisible();
      if (!tabVisibleRef.current || !auth || !route.chatId) return;
      const chat = chats.find((c) => c.id === route.chatId);
      if (chat) {
        void markChatRead(route.chatId, chat.lastMessage?.createdAt ?? Date.now(), { force: true });
      } else {
        void refreshUnreadCounts(chats);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [auth, route.chatId, chats, markChatRead, refreshUnreadCounts]);

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
        await saveMessage({
          id: msg.id,
          chatId: msg.chatId,
          senderId: msg.senderId,
          senderName: usernames.get(msg.senderId) || '?',
          text,
          type: msg.type,
          imageUrl,
          createdAt: msg.createdAt,
        });
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
          onLogout={handleLogout}
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
    </div>
  );
}
