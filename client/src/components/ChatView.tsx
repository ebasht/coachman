import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import type { Chat } from '../lib/api';
import { api } from '../lib/api';
import type { StoredMessage } from '../lib/storage';
import { getMessages, saveMessage, saveCachedImage } from '../lib/storage';
import { decryptMessage } from '../lib/messages';
import { encryptChatMessage, getChatEncryptionKey } from '../lib/messages-encrypt';
import { encryptBinary, encryptDirectBinary, importPublicKey } from '../lib/crypto';
import { compressImage } from '../lib/image';
import { hydrateStoredMessages, migrateLocalPreview, persistLocalPreview } from '../lib/image-preview';
import { enqueueTextOutbox, enqueueImageOutbox, OUTBOX_FLUSHED_EVENT } from '../lib/outbox';
import { formatDateDivider, formatMessageTime, isFirstInMessageGroup, isLastInMessageGroup, isSameDay, chatInitials } from '../lib/chat-format';
import { notify } from '../lib/notify';
import { GroupMembersModal } from './GroupMembersModal';
import { KeyVerifyModal } from './KeyVerifyModal';
import { Notice } from './Notice';
import { LinkPreview } from './LinkPreview';
import { MessageText } from './MessageText';

interface Props {
  chat: Chat;
  userId: string;
  publicKey: string;
  privateKey: CryptoKey;
  privateKeyB64: string;
  onBack?: () => void;
  onMembersChanged: (left?: boolean) => void;
  onDeleteChat?: () => void;
  canDeleteChat?: boolean;
  onRead?: (at: number) => void;
  incomingMessage?: StoredMessage | null;
}

export function ChatView({
  chat,
  userId,
  publicKey,
  privateKey,
  privateKeyB64,
  onBack,
  onMembersChanged,
  onDeleteChat,
  canDeleteChat = false,
  onRead,
  incomingMessage,
}: Props) {
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');

  const reportSendError = (message: string) => {
    setSendError(message);
    notify.error(message);
  };
  const [showMembers, setShowMembers] = useState(false);
  const [showKeyVerify, setShowKeyVerify] = useState(false);
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
  const otherMember = chat.type === 'direct' ? chat.members.find((m) => m.id !== userId) : null;

  const loadAndDecrypt = useCallback(async () => {
    const cached = await hydrateStoredMessages(await getMessages(chat.id));
    if (cached.length) {
      updateMessages(
        cached.sort((a, b) => a.createdAt - b.createdAt),
        openingChatRef.current ? { stickToBottom: true } : undefined,
      );
    }

    try {
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

  const sendText = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setSendError('');
    const plain = text.trim();
    const tempId = `pending-${crypto.randomUUID()}`;
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

      if (!navigator.onLine) {
        await enqueueTextOutbox(chat.id, tempId, ciphertext, iv, plain);
        setSending(false);
        return;
      }

      try {
        const msg = await api.sendMessage(chat.id, { ciphertext, iv, type: 'text' });
        const stored: StoredMessage = {
          id: msg.id,
          chatId: chat.id,
          senderId: userId,
          senderName: usernames.get(userId) || 'Я',
          text: plain,
          type: 'text',
          createdAt: msg.createdAt,
        };
        const { replacePendingMessage } = await import('../lib/storage');
        await replacePendingMessage(tempId, stored);
        updateMessages((prev) => prev.map((m) => (m.id === tempId ? stored : m)), { stickToBottom: true });
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Не удалось отправить';
        reportSendError(message);
        await enqueueTextOutbox(chat.id, tempId, ciphertext, iv, plain);
      }
    } catch {
      notify.error('Не удалось подготовить сообщение.');
    }
    setSending(false);
  };

  const sendImage = async (file: File) => {
    if (sending) return;
    setSending(true);
    setSendError('');
    const tempId = `pending-${crypto.randomUUID()}`;
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

      if (!navigator.onLine) {
        await enqueueImageOutbox(
          chat.id,
          tempId,
          await imageBlob.arrayBuffer(),
          imageIv,
          mimeType,
          msgCipher,
          msgIv,
          previewData,
          mimeType,
        );
        setSending(false);
        return;
      }

      try {
        const blob = imageBlob;
        const { id: imageId } = await api.uploadImage(chat.id, blob, imageIv, mimeType);
        const msg = await api.sendMessage(chat.id, {
          ciphertext: msgCipher,
          iv: msgIv,
          type: 'image',
          imageId,
        });
        await saveCachedImage(imageId, previewData, mimeType);
        await migrateLocalPreview(tempId, msg.id, imageId);
        const stored: StoredMessage = {
          id: msg.id,
          chatId: chat.id,
          senderId: userId,
          senderName: usernames.get(userId) || 'Я',
          text: '📷 Изображение',
          type: 'image',
          imageId,
          createdAt: msg.createdAt,
        };
        const { replacePendingMessage } = await import('../lib/storage');
        await replacePendingMessage(tempId, stored);
        const [hydrated] = await hydrateStoredMessages([stored]);
        updateMessages((prev) => prev.map((m) => (m.id === tempId ? hydrated : m)), { stickToBottom: true });
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Не удалось отправить';
        notify.warning(`Фото в очереди: ${message}`);
        await enqueueImageOutbox(
          chat.id,
          tempId,
          await imageBlob.arrayBuffer(),
          imageIv,
          mimeType,
          msgCipher,
          msgIv,
          previewData,
          mimeType,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Неизвестная ошибка';
      notify.error(`Не удалось отправить изображение: ${msg}`);
    }
    setSending(false);
  };

  return (
    <div className="chat-view">
      <header className="chat-view-header">
        {onBack && (
          <button type="button" className="icon-btn back" onClick={onBack} aria-label="Назад">
            ←
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
          {chat.type === 'group' ? (
            <button type="button" className="members-count-btn" onClick={() => setShowMembers(true)}>
              {chat.members.length} участников
            </button>
          ) : (
            <button type="button" className="members-count-btn" onClick={() => setShowKeyVerify(true)}>
              сверить ключ
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

      {showKeyVerify && otherMember && (
        <KeyVerifyModal
          myPublicKey={publicKey}
          theirPublicKey={otherMember.publicKey}
          theirUsername={otherMember.username}
          onClose={() => setShowKeyVerify(false)}
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
                    <img src={m.imageUrl} alt="Изображение" className="msg-image" loading="lazy" />
                  ) : (
                    <>
                      <MessageText text={m.text} />
                      {m.type === 'text' && !m.text.startsWith('[') && <LinkPreview text={m.text} />}
                    </>
                  )}
                  <time>
                    {m.pending && <span className="pending-icon" aria-label="Отправляется">⏳</span>}
                    {formatMessageTime(m.createdAt)}
                  </time>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} className="messages-end" />
      </div>

      {sendError && <Notice variant="error">{sendError}</Notice>}

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
          className="icon-btn compose-attach"
          onClick={() => fileRef.current?.click()}
          title="Фото"
          aria-label="Прикрепить фото"
        >
          📷
        </button>
        <div className="compose-input-wrap">
          <input
            type="text"
            placeholder="Сообщение..."
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
          className="compose-send"
          onClick={sendText}
          disabled={sending || !text.trim()}
          aria-label="Отправить"
        >
          ↑
        </button>
      </footer>
    </div>
  );
}
