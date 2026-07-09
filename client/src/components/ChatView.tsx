import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import type { Chat } from '../lib/api';
import { api } from '../lib/api';
import type { StoredMessage } from '../lib/storage';
import { getMessages, saveMessage } from '../lib/storage';
import { decryptMessage } from '../lib/messages';
import { encryptChatMessage, getChatEncryptionKey } from '../lib/messages-encrypt';
import { encryptBinary, encryptDirectBinary, importPublicKey } from '../lib/crypto';
import { compressImage } from '../lib/image';
import { hydrateStoredMessages, migrateLocalPreview, persistLocalPreview } from '../lib/image-preview';
import { enqueueTextOutbox, enqueueImageOutbox, flushOutbox, OUTBOX_FLUSHED_EVENT } from '../lib/outbox';
import { isOnline } from '../lib/network';
import { formatDateDivider, formatMessageTime, isFirstInMessageGroup, isLastInMessageGroup, isSameDay, chatInitials } from '../lib/chat-format';
import { notify } from '../lib/notify';
import { GroupMembersModal } from './GroupMembersModal';
import { LinkPreview } from './LinkPreview';
import { MessageText } from './MessageText';
import { MessageStatus } from './MessageStatus';

interface Props {
  chat: Chat;
  userId: string;
  privateKey: CryptoKey;
  privateKeyB64: string;
  onBack?: () => void;
  onMembersChanged: (left?: boolean) => void;
  onDeleteChat?: () => void;
  canDeleteChat?: boolean;
  onRead?: (at: number) => void;
  incomingMessage?: StoredMessage | null;
  onMessagesChanged?: () => void;
}

export function ChatView({
  chat,
  userId,
  privateKey,
  privateKeyB64,
  onBack,
  onMembersChanged,
  onDeleteChat,
  canDeleteChat = false,
  onRead,
  incomingMessage,
  onMessagesChanged,
}: Props) {
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const [showMembers, setShowMembers] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const openingChatRef = useRef(true);
  const initialLoadRef = useRef(true);
  const scrollAnchorRef = useRef<{ top: number; height: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
  const loadAndDecrypt = useCallback(async () => {
    const cached = await hydrateStoredMessages(await getMessages(chat.id));
    try {
      if (cached.length) {
        updateMessages(
          cached.sort((a, b) => a.createdAt - b.createdAt),
          openingChatRef.current ? { stickToBottom: true } : undefined,
        );
      }

      if (!navigator.onLine) {
        const latest = cached.filter((m) => !m.pending).reduce((max, m) => Math.max(max, m.createdAt), 0);
        if (latest > 0) onRead?.(latest);
        return;
      }

      const lastAt = cached.filter((m) => !m.pending).length
        ? Math.max(...cached.filter((m) => !m.pending).map((m) => m.createdAt))
        : 0;
      const raw = await api.getMessages(chat.id, lastAt);
      const decrypted: StoredMessage[] = [];

      for (const msg of raw) {
        const existing = cached.find((m) => m.id === msg.id);
        if (existing && msg.senderId === userId) {
          const [hydrated] = await hydrateStoredMessages([existing]);
          decrypted.push(hydrated);
          continue;
        }
        if (msg.senderId === userId) {
          const pending = cached.find(
            (m) => m.pending && m.senderId === userId && Math.abs(m.createdAt - msg.createdAt) < 120_000,
          );
          if (pending) {
            const stored: StoredMessage = {
              ...pending,
              id: msg.id,
              createdAt: msg.createdAt,
              pending: false,
              imageId: msg.imageId,
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
        const { text: plain } = await decryptMessage(msg, chat, userId, privateKeyB64, usernames);
        if (msg.senderId === userId && plain === '[ваше сообщение]') continue;
        const stored: StoredMessage = {
          id: msg.id,
          chatId: msg.chatId,
          senderId: msg.senderId,
          senderName: usernames.get(msg.senderId) || '?',
          text: plain,
          type: msg.type,
          imageId: msg.imageId,
          createdAt: msg.createdAt,
        };
        await saveMessage(stored);
        const [hydrated] = await hydrateStoredMessages([stored]);
        decrypted.push(hydrated);
      }

      if (decrypted.length) {
        updateMessages((prev) => {
          const pending = prev.filter((m) => m.pending);
          const map = new Map(prev.filter((m) => !m.pending).map((m) => [m.id, m]));
          for (const m of decrypted) map.set(m.id, m);
          return [...map.values(), ...pending].sort((a, b) => a.createdAt - b.createdAt);
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
    void loadAndDecrypt();
  }, [chat.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!incomingMessage || incomingMessage.chatId !== chat.id) return;
    updateMessages((prev) => {
      if (prev.some((m) => m.id === incomingMessage.id)) return prev;
      return [...prev, incomingMessage].sort((a, b) => a.createdAt - b.createdAt);
    }, { stickToBottom: stickToBottomRef.current });
  }, [incomingMessage, chat.id, updateMessages]);

  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) void loadAndDecrypt();
    };
    const onFlushed = () => {
      void loadAndDecrypt();
    };
    window.addEventListener('online', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener(OUTBOX_FLUSHED_EVENT, onFlushed);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('online', refresh);
      window.removeEventListener('focus', refresh);
      window.removeEventListener(OUTBOX_FLUSHED_EVENT, onFlushed);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [loadAndDecrypt]);

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

  const refreshFromStorage = useCallback(async () => {
    const fresh = await hydrateStoredMessages(await getMessages(chat.id));
    updateMessages(fresh.sort((a, b) => a.createdAt - b.createdAt), { stickToBottom: true });
  }, [chat.id, updateMessages]);

  const sendText = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    const plain = text.trim();
    const tempId = `pending-${crypto.randomUUID()}`;
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
        createdAt: Date.now(),
        pending: true,
      };
      await saveMessage(pending);
      updateMessages((prev) => [...prev, pending], { stickToBottom: true });
      setText('');
      onMessagesChanged?.();
      await enqueueTextOutbox(chat.id, tempId, ciphertext, iv, plain);
      queued = true;
    } catch {
      notify.error('Не удалось подготовить сообщение.');
    } finally {
      setSending(false);
    }

    if (!queued) return;
    if (isOnline()) {
      void flushOutbox().then((sent) => {
        if (sent > 0) void refreshFromStorage();
      });
    } else {
      notify.info('Сообщение будет отправлено при появлении сети');
    }
  };

  const sendImage = async (file: File) => {
    if (sending) return;
    setSending(true);
    const tempId = `pending-${crypto.randomUUID()}`;
    let queued = false;
    try {
      const compressed = await compressImage(file);
      const previewData = await compressed.arrayBuffer();
      const mimeType = compressed.type || 'image/jpeg';
      let imageBlob: Blob;
      let imageIv: string;

      if (chat.type === 'direct') {
        const other = chat.members.find((m) => m.id !== userId)!;
        const theirPub = await importPublicKey(other.publicKey);
        const { ciphertext, envelope } = await encryptDirectBinary(previewData, theirPub);
        imageBlob = new Blob([ciphertext]);
        imageIv = envelope;
      } else {
        const encKey = await getChatEncryptionKey(chat, userId, privateKeyB64);
        const { ciphertext, iv } = await encryptBinary(previewData, encKey);
        imageBlob = new Blob([ciphertext]);
        imageIv = iv;
      }

      const payload = JSON.stringify({ name: file.name });
      const { ciphertext: msgCipher, iv: msgIv } = await encryptChatMessage(payload, chat, userId, privateKeyB64);

      const pending: StoredMessage = {
        id: tempId,
        chatId: chat.id,
        senderId: userId,
        senderName: usernames.get(userId) || 'Я',
        text: '📷 Изображение',
        type: 'image',
        createdAt: Date.now(),
        pending: true,
      };
      await persistLocalPreview(tempId, previewData, mimeType);
      await saveMessage(pending);
      const [hydratedPending] = await hydrateStoredMessages([pending]);
      updateMessages((prev) => [...prev, hydratedPending], { stickToBottom: true });
      onMessagesChanged?.();

      const imageBuffer = await imageBlob.arrayBuffer();
      await enqueueImageOutbox(
        chat.id,
        tempId,
        imageBuffer,
        imageIv,
        mimeType,
        msgCipher,
        msgIv,
        previewData,
        mimeType,
      );
      queued = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Неизвестная ошибка';
      notify.error(`Не удалось отправить изображение: ${msg}`);
    } finally {
      setSending(false);
    }

    if (!queued) return;
    if (isOnline()) {
      void flushOutbox().then((sent) => {
        if (sent > 0) void refreshFromStorage();
      });
    } else {
      notify.info('Фото будет отправлено при появлении сети');
    }
  };

  return (
    <div className="chat-view">
      <header className="chat-view-header">
        {onBack && (
          <button type="button" className="tg-back-btn" onClick={onBack} aria-label="Назад">
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden><path fill="currentColor" d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
          </button>
        )}
        <span
          className={`chat-avatar ${chat.type === 'group' ? 'group' : ''}`}
          aria-hidden
        >
          {chat.type === 'group' ? '👥' : chatInitials(chat.displayName)}
        </span>
        <div className="chat-view-header-info">
          <h2>{chat.displayName}</h2>
          {chat.type === 'group' && (
            <button type="button" className="members-count-btn" onClick={() => setShowMembers(true)}>
              {chat.members.length} участников
            </button>
          )}
        </div>
        {canDeleteChat && onDeleteChat && (
          <button
            type="button"
            className="icon-btn chat-delete-btn"
            title="Удалить чат"
            aria-label="Удалить чат"
            onClick={onDeleteChat}
          >
            🗑
          </button>
        )}
      </header>

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

          return (
            <div key={m.id} className="message-wrap">
              {showDateDivider && (
                <div className="date-divider" role="separator">
                  <span>{formatDateDivider(m.createdAt)}</span>
                </div>
              )}
              <div
                className={[
                  'message-row',
                  isOwn ? 'own' : 'other',
                  groupClass,
                  m.pending ? 'pending' : '',
                ].filter(Boolean).join(' ')}
              >
                {chat.type === 'group' && !isOwn && (
                  <span className="message-avatar" aria-hidden>
                    {firstInGroup ? chatInitials(m.senderName) : ''}
                  </span>
                )}
                <div
                  className={[
                    'message',
                    isOwn ? 'own' : '',
                    m.pending ? 'pending' : '',
                    groupClass,
                  ].filter(Boolean).join(' ')}
                >
                  {chat.type === 'group' && !isOwn && firstInGroup && (
                    <span className="sender">{m.senderName}</span>
                  )}
                  {m.type === 'image' && m.imageUrl ? (
                    <>
                      <img src={m.imageUrl} alt="Изображение" className="msg-image" loading="lazy" />
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
                </div>
              </div>
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
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) sendImage(f);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className="compose-attach"
          onClick={() => fileRef.current?.click()}
          title="Фото"
          aria-label="Прикрепить фото"
        >
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden><path fill="currentColor" d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5a2.5 2.5 0 0 1 5 0v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5a2.5 2.5 0 0 0 5 0V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>
        </button>
        <div className="compose-input-wrap">
          <input
            type="text"
            placeholder="Сообщение"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && sendText()}
            enterKeyHint="send"
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
    </div>
  );
}
