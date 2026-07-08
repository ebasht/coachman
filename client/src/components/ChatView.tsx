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
import { enqueueTextOutbox, enqueueImageOutbox } from '../lib/outbox';
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
  onRead?: (at: number) => void;
}

export function ChatView({
  chat,
  userId,
  publicKey,
  privateKey,
  privateKeyB64,
  onBack,
  onMembersChanged,
  onRead,
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
  const scrollToBottomOnUpdateRef = useRef(false);
  const preservedScrollRef = useRef<{ top: number; height: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const isNearBottom = useCallback((el: HTMLElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  }, []);

  const queueScrollToBottom = useCallback(() => {
    scrollToBottomOnUpdateRef.current = true;
    preservedScrollRef.current = null;
  }, []);

  const preserveScroll = useCallback(() => {
    const el = messagesRef.current;
    if (!el) return;
    preservedScrollRef.current = { top: el.scrollTop, height: el.scrollHeight };
    scrollToBottomOnUpdateRef.current = false;
  }, []);

  const applyMessagesUpdate = useCallback((updater: (prev: StoredMessage[]) => StoredMessage[]) => {
    const el = messagesRef.current;
    if (el && !isNearBottom(el)) {
      preserveScroll();
    } else {
      queueScrollToBottom();
      stickToBottomRef.current = true;
    }
    setMessages(updater);
  }, [isNearBottom, preserveScroll, queueScrollToBottom]);

  const usernames = new Map(chat.members.map((m) => [m.id, m.username]));
  const otherMember = chat.type === 'direct' ? chat.members.find((m) => m.id !== userId) : null;

  const loadAndDecrypt = useCallback(async () => {
    const el = messagesRef.current;
    const shouldStick = !el || isNearBottom(el);
    if (shouldStick) {
      queueScrollToBottom();
      stickToBottomRef.current = true;
    } else {
      preserveScroll();
    }

    const cached = await hydrateStoredMessages(await getMessages(chat.id));
    if (cached.length) {
      setMessages(cached.sort((a, b) => a.createdAt - b.createdAt));
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
        applyMessagesUpdate((prev) => {
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
    }
  }, [chat, userId, privateKeyB64, onRead, applyMessagesUpdate, isNearBottom, preserveScroll, queueScrollToBottom]);

  useEffect(() => {
    stickToBottomRef.current = true;
    queueScrollToBottom();
    void loadAndDecrypt();
  }, [chat.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) void loadAndDecrypt();
    };
    window.addEventListener('online', refresh);
    return () => window.removeEventListener('online', refresh);
  }, [loadAndDecrypt]);

  useLayoutEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    if (scrollToBottomOnUpdateRef.current) {
      el.scrollTop = el.scrollHeight;
      scrollToBottomOnUpdateRef.current = false;
      preservedScrollRef.current = null;
      return;
    }
    if (preservedScrollRef.current) {
      const { top, height } = preservedScrollRef.current;
      el.scrollTop = top + (el.scrollHeight - height);
      preservedScrollRef.current = null;
    }
  }, [messages]);

  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const onScroll = () => {
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
      queueScrollToBottom();
      stickToBottomRef.current = true;
      setMessages((prev) => [...prev, pending]);
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
        applyMessagesUpdate((prev) => prev.map((m) => (m.id === tempId ? stored : m)));
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
      queueScrollToBottom();
      stickToBottomRef.current = true;
      setMessages((prev) => [...prev, hydratedPending]);

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
        applyMessagesUpdate((prev) => prev.map((m) => (m.id === tempId ? hydrated : m)));
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
      <header>
        {onBack && (
          <button type="button" className="icon-btn back" onClick={onBack}>
            ←
          </button>
        )}
        <div>
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
        {messages.map((m) => (
          <div
            key={m.id}
            className={`message ${m.senderId === userId ? 'own' : ''} ${m.pending ? 'pending' : ''}`}
          >
            {chat.type === 'group' && m.senderId !== userId && (
              <span className="sender">{m.senderName}</span>
            )}
            {m.type === 'image' && m.imageUrl ? (
              <img src={m.imageUrl} alt="Изображение" className="msg-image" />
            ) : (
              <>
                <MessageText text={m.text} />
                {m.type === 'text' && !m.text.startsWith('[') && <LinkPreview text={m.text} />}
              </>
            )}
            <time>
              {m.pending && '⏳ '}
              {new Date(m.createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}
            </time>
          </div>
        ))}
        <div ref={bottomRef} />
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
        <button type="button" className="icon-btn" onClick={() => fileRef.current?.click()} title="Фото">
          📷
        </button>
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
        <button type="button" onClick={sendText} disabled={sending || !text.trim()}>
          →
        </button>
      </footer>
    </div>
  );
}
