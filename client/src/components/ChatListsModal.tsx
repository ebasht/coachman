import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Chat, type RawChatList, type RawChatListItem } from '../lib/api';
import { decryptChatShared, encryptChatShared } from '../lib/messages-encrypt';
import {
  emptyLocalList,
  enqueueListOp,
  loadCachedList,
  persistList,
} from '../lib/list-sync';
import type { StoredChatList, StoredChatListItem } from '../lib/storage';
import { notify } from '../lib/notify';
import { postListEventMessage, type ListEventKind } from '../lib/list-events';
import { Notice } from './Notice';

type ListState = StoredChatList;

interface Props {
  chat: Chat;
  userId: string;
  privateKeyB64: string;
  listEvent?: ChatListEvent | null;
  onSystemMessage?: (msg: import('../lib/storage').StoredMessage) => void;
  onClose: () => void;
}

export type ChatListEvent = {
  action: 'upsert' | 'delete' | 'item_upsert' | 'item_delete';
  chatId: string;
  listId?: string;
  list?: RawChatList;
  item?: RawChatListItem;
  itemId?: string;
  actorUserId?: string;
};

function sortItems(items: StoredChatListItem[]) {
  return [...items].sort(
    (a, b) => Number(a.done) - Number(b.done) || a.position - b.position || a.updatedAt - b.updatedAt,
  );
}

async function decryptList(
  raw: RawChatList,
  chat: Chat,
  userId: string,
  privateKeyB64: string,
): Promise<ListState> {
  let title = 'Список';
  try {
    title = await decryptChatShared(raw.titleCiphertext, raw.titleIv, chat, userId, privateKeyB64);
  } catch {
    title = 'Список';
  }
  const items: StoredChatListItem[] = [];
  for (const item of raw.items || []) {
    let text = '…';
    try {
      text = await decryptChatShared(item.textCiphertext, item.textIv, chat, userId, privateKeyB64);
    } catch {
      text = '[не удалось расшифровать]';
    }
    items.push({
      id: item.id,
      listId: item.listId,
      text,
      done: !!item.done,
      position: item.position,
      updatedAt: item.updatedAt,
    });
  }
  return {
    id: raw.id,
    chatId: raw.chatId,
    title,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    items: sortItems(items),
    localOnly: false,
  };
}

async function decryptItem(
  item: RawChatListItem,
  chat: Chat,
  userId: string,
  privateKeyB64: string,
): Promise<StoredChatListItem> {
  let text = '…';
  try {
    text = await decryptChatShared(item.textCiphertext, item.textIv, chat, userId, privateKeyB64);
  } catch {
    text = '[не удалось расшифровать]';
  }
  return {
    id: item.id,
    listId: item.listId,
    text,
    done: !!item.done,
    position: item.position,
    updatedAt: item.updatedAt,
  };
}

async function fetchRemoteList(
  chat: Chat,
  userId: string,
  privateKeyB64: string,
): Promise<ListState> {
  const rawLists = await api.listChatLists(chat.id);
  let raw = rawLists[0];
  if (!raw) {
    const { ciphertext, iv } = await encryptChatShared('Список', chat, userId, privateKeyB64);
    raw = await api.createChatList(chat.id, ciphertext, iv);
  }
  return decryptList(raw, chat, userId, privateKeyB64);
}

export function ChatListsModal({ chat, userId, privateKeyB64, listEvent, onSystemMessage, onClose }: Props) {
  const chatRef = useRef(chat);
  chatRef.current = chat;

  const [list, setList] = useState<ListState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [offline, setOffline] = useState(!navigator.onLine);

  const emitListSystemMessage = useCallback(
    (kind: ListEventKind, eventId: string, itemText?: string) => {
      const username = chatRef.current.members.find((m) => m.id === userId)?.username || 'Я';
      void postListEventMessage({
        event: { chatId: chatRef.current.id, eventId, kind, itemText },
        chat: chatRef.current,
        userId,
        username,
        privateKeyB64,
        onLocalMessage: onSystemMessage,
      }).catch(() => {
        // best-effort marker
      });
    },
    [userId, privateKeyB64, onSystemMessage],
  );

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const applyList = useCallback(async (next: ListState) => {
    setList(next);
    await persistList(next);
  }, []);

  const loadList = useCallback(async () => {
    const currentChat = chatRef.current;
    setError('');
    try {
      const cached = await loadCachedList(currentChat.id);
      if (cached) {
        setList(cached);
        setLoading(false);
      }

      if (!navigator.onLine) {
        if (!cached) {
          const local = emptyLocalList(currentChat.id);
          await applyList(local);
          await enqueueListOp({
            id: crypto.randomUUID(),
            chatId: currentChat.id,
            listId: local.id,
            kind: 'create-list',
            createdAt: Date.now(),
          });
        }
        setLoading(false);
        return;
      }

      const remote = await fetchRemoteList(currentChat, userId, privateKeyB64);
      if (cached?.items.some((i) => i.pending)) {
        const remoteIds = new Set(remote.items.map((i) => i.id));
        const pending = cached.items.filter((i) => i.pending && !remoteIds.has(i.id));
        remote.items = sortItems([...remote.items, ...pending]);
      }
      await applyList(remote);
    } catch (e) {
      const cached = await loadCachedList(currentChat.id);
      if (cached) setList(cached);
      else setError(e instanceof Error ? e.message : 'Не удалось загрузить список');
    } finally {
      setLoading(false);
    }
  }, [userId, privateKeyB64, applyList]);

  useEffect(() => {
    setList(null);
    setLoading(true);
    setError('');
    let cancelled = false;
    (async () => {
      const currentChat = chatRef.current;
      try {
        const cached = await loadCachedList(currentChat.id);
        if (cancelled) return;
        if (cached) {
          setList(cached);
          setLoading(false);
        }

        if (!navigator.onLine) {
          if (!cached) {
            const local = emptyLocalList(currentChat.id);
            if (!cancelled) {
              setList(local);
              await persistList(local);
              await enqueueListOp({
                id: crypto.randomUUID(),
                chatId: currentChat.id,
                listId: local.id,
                kind: 'create-list',
                createdAt: Date.now(),
              });
            }
          }
          if (!cancelled) setLoading(false);
          return;
        }

        const remote = await fetchRemoteList(currentChat, userId, privateKeyB64);
        if (cancelled) return;
        if (cached?.items.some((i) => i.pending)) {
          const remoteIds = new Set(remote.items.map((i) => i.id));
          const pending = cached.items.filter((i) => i.pending && !remoteIds.has(i.id));
          remote.items = sortItems([...remote.items, ...pending]);
        }
        setList(remote);
        await persistList(remote);
      } catch (e) {
        if (cancelled) return;
        const cached = await loadCachedList(currentChat.id);
        if (cached) setList(cached);
        else setError(e instanceof Error ? e.message : 'Не удалось загрузить список');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chat.id, userId, privateKeyB64]);

  useEffect(() => {
    if (!listEvent || listEvent.chatId !== chat.id) return;
    let cancelled = false;
    const currentChat = chatRef.current;

    const apply = async () => {
      if (listEvent.action === 'delete' && listEvent.listId) {
        setList((prev) => (prev?.id === listEvent.listId ? null : prev));
        void loadList();
        return;
      }
      if (listEvent.action === 'upsert' && listEvent.list) {
        const decrypted = await decryptList(listEvent.list, currentChat, userId, privateKeyB64);
        if (cancelled) return;
        setList((prev) => {
          const next = {
            ...decrypted,
            items: decrypted.items.length ? decrypted.items : prev?.items ?? [],
          };
          void persistList(next);
          return next;
        });
        return;
      }
      if (listEvent.action === 'item_upsert' && listEvent.item && listEvent.listId) {
        const decrypted = await decryptItem(listEvent.item, currentChat, userId, privateKeyB64);
        if (cancelled) return;
        setList((prev) => {
          if (!prev || (prev.id !== listEvent.listId && !prev.localOnly)) return prev;
          const idx = prev.items.findIndex((i) => i.id === decrypted.id);
          const items = [...prev.items];
          if (idx === -1) items.push(decrypted);
          else items[idx] = decrypted;
          const next = { ...prev, items: sortItems(items), updatedAt: decrypted.updatedAt };
          void persistList(next);
          return next;
        });
        return;
      }
      if (listEvent.action === 'item_delete' && listEvent.listId && listEvent.itemId) {
        setList((prev) => {
          if (!prev || prev.id !== listEvent.listId) return prev;
          const next = { ...prev, items: prev.items.filter((i) => i.id !== listEvent.itemId) };
          void persistList(next);
          return next;
        });
      }
    };

    void apply();
    return () => {
      cancelled = true;
    };
  }, [listEvent, chat.id, userId, privateKeyB64, loadList]);

  const openCount = list?.items.filter((i) => !i.done).length ?? 0;
  const doneCount = list?.items.filter((i) => i.done).length ?? 0;
  const draftInputRef = useRef<HTMLInputElement>(null);
  const addingRef = useRef(false);

  const focusDraft = useCallback(() => {
    const el = draftInputRef.current;
    if (!el) return;
    // Defer past re-render / button disable so mobile keyboard stays open.
    requestAnimationFrame(() => {
      el.focus({ preventScroll: true });
    });
  }, []);

  useEffect(() => {
    if (!loading && list) focusDraft();
  }, [loading, list?.id, focusDraft]);

  const addItem = async () => {
    if (!list || addingRef.current) return;
    const text = draft.trim();
    if (!text) return;
    addingRef.current = true;
    setBusyId('add');
    const itemId = crypto.randomUUID();
    const now = Date.now();
    const optimistic: StoredChatListItem = {
      id: itemId,
      listId: list.id,
      text,
      done: false,
      position: list.items.length,
      updatedAt: now,
      pending: !navigator.onLine || list.localOnly,
    };
    const next = { ...list, items: sortItems([...list.items, optimistic]), updatedAt: now };
    setList(next);
    setDraft('');
    focusDraft();
    await persistList(next);

    try {
      if (!navigator.onLine || list.localOnly) {
        await enqueueListOp({
          id: crypto.randomUUID(),
          chatId: chat.id,
          listId: list.id,
          kind: 'add',
          itemId,
          text,
          createdAt: now,
        });
        emitListSystemMessage('item_add', itemId, text);
        return;
      }
      const { ciphertext, iv } = await encryptChatShared(text, chatRef.current, userId, privateKeyB64);
      const raw = await api.addChatListItem(chat.id, list.id, ciphertext, iv);
      const decrypted = await decryptItem(raw, chatRef.current, userId, privateKeyB64);
      const synced = {
        ...next,
        items: sortItems(next.items.map((i) => (i.id === itemId ? { ...decrypted, pending: false } : i))),
      };
      setList(synced);
      await persistList(synced);
      emitListSystemMessage('item_add', decrypted.id, decrypted.text || text);
    } catch (e) {
      await enqueueListOp({
        id: crypto.randomUUID(),
        chatId: chat.id,
        listId: list.id,
        kind: 'add',
        itemId,
        text,
        createdAt: now,
      });
      emitListSystemMessage('item_add', itemId, text);
      notify.info('Пункт сохранится при появлении сети');
    } finally {
      addingRef.current = false;
      setBusyId(null);
      focusDraft();
    }
  };

  const toggleItem = async (item: StoredChatListItem) => {
    if (!list) return;
    setBusyId(item.id);
    const nextDone = !item.done;
    const next = {
      ...list,
      items: sortItems(list.items.map((i) => (i.id === item.id ? { ...i, done: nextDone } : i))),
      updatedAt: Date.now(),
    };
    setList(next);
    await persistList(next);

    try {
      if (!navigator.onLine || list.localOnly || item.pending) {
        await enqueueListOp({
          id: crypto.randomUUID(),
          chatId: chat.id,
          listId: list.id,
          kind: 'toggle',
          itemId: item.id,
          done: nextDone,
          createdAt: Date.now(),
        });
        emitListSystemMessage(
          nextDone ? 'item_done' : 'item_undone',
          `${item.id}:${nextDone ? '1' : '0'}:${Date.now()}`,
          item.text,
        );
        return;
      }
      await api.setChatListItemDone(chat.id, list.id, item.id, nextDone);
      emitListSystemMessage(
        nextDone ? 'item_done' : 'item_undone',
        `${item.id}:${nextDone ? '1' : '0'}:${Date.now()}`,
        item.text,
      );
    } catch {
      await enqueueListOp({
        id: crypto.randomUUID(),
        chatId: chat.id,
        listId: list.id,
        kind: 'toggle',
        itemId: item.id,
        done: nextDone,
        createdAt: Date.now(),
      });
      emitListSystemMessage(
        nextDone ? 'item_done' : 'item_undone',
        `${item.id}:${nextDone ? '1' : '0'}:${Date.now()}`,
        item.text,
      );
    } finally {
      setBusyId(null);
    }
  };

  const removeItem = async (itemId: string) => {
    if (!list) return;
    setBusyId(itemId);
    const removed = list.items.find((i) => i.id === itemId);
    const next = { ...list, items: list.items.filter((i) => i.id !== itemId), updatedAt: Date.now() };
    setList(next);
    await persistList(next);

    try {
      if (!navigator.onLine || list.localOnly || removed?.pending) {
        await enqueueListOp({
          id: crypto.randomUUID(),
          chatId: chat.id,
          listId: list.id,
          kind: 'delete',
          itemId,
          createdAt: Date.now(),
        });
        emitListSystemMessage('item_delete', itemId, removed?.text);
        return;
      }
      await api.deleteChatListItem(chat.id, list.id, itemId);
      emitListSystemMessage('item_delete', itemId, removed?.text);
    } catch {
      await enqueueListOp({
        id: crypto.randomUUID(),
        chatId: chat.id,
        listId: list.id,
        kind: 'delete',
        itemId,
        createdAt: Date.now(),
      });
      emitListSystemMessage('item_delete', itemId, removed?.text);
    } finally {
      setBusyId(null);
    }
  };

  const clearDone = async () => {
    if (!list) return;
    const done = list.items.filter((i) => i.done);
    if (done.length === 0) return;
    if (!window.confirm(`Удалить отмеченные пункты (${done.length})?`)) return;
    setBusyId('clear');
    const next = {
      ...list,
      items: list.items.filter((i) => !i.done),
      updatedAt: Date.now(),
    };
    setList(next);
    await persistList(next);
    try {
      for (const item of done) {
        if (!navigator.onLine || list.localOnly || item.pending) {
          await enqueueListOp({
            id: crypto.randomUUID(),
            chatId: chat.id,
            listId: list.id,
            kind: 'delete',
            itemId: item.id,
            createdAt: Date.now(),
          });
          continue;
        }
        try {
          await api.deleteChatListItem(chat.id, list.id, item.id);
        } catch {
          await enqueueListOp({
            id: crypto.randomUUID(),
            chatId: chat.id,
            listId: list.id,
            kind: 'delete',
            itemId: item.id,
            createdAt: Date.now(),
          });
        }
      }
      if (done.length > 0) {
        const labels = done.map((i) => i.text.trim()).filter(Boolean);
        emitListSystemMessage(
          'item_delete',
          `clear-done:${Date.now()}`,
          labels.length > 0 ? labels.join(', ') : undefined,
        );
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="modal-overlay shared-list-overlay" onClick={onClose}>
      <div className="modal shared-list-modal" onClick={(e) => e.stopPropagation()}>
        <header className="shared-list-header">
          <div>
            <h2>Список</h2>
            {!loading && list && (
              <p className="shared-list-meta">
                {offline ? 'Офлайн · ' : ''}
                {list.items.length === 0
                  ? 'Пока пусто'
                  : openCount === 0
                    ? 'Всё отмечено'
                    : `Осталось ${openCount}`}
              </p>
            )}
          </div>
          <button type="button" className="shared-list-close" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </header>

        {error && (
          <Notice variant="error">
            {error}
            <button type="button" className="shared-list-retry" onClick={() => void loadList()}>
              Повторить
            </button>
          </Notice>
        )}

        {loading && !list ? (
          <p className="shared-list-empty">Загрузка…</p>
        ) : !list ? (
          <p className="shared-list-empty">Не удалось открыть список</p>
        ) : (
          <>
            <ul className="shared-list-items">
              {list.items.length === 0 && (
                <li className="shared-list-empty-row">Пишите пункт и нажимайте Enter</li>
              )}
              {list.items.map((item) => (
                <li key={item.id} className={item.done ? 'done' : ''}>
                  <label>
                    <input
                      type="checkbox"
                      checked={item.done}
                      disabled={busyId === item.id}
                      onChange={() => void toggleItem(item)}
                    />
                    <span>{item.text}</span>
                  </label>
                  <button
                    type="button"
                    className="shared-list-remove"
                    aria-label="Удалить"
                    disabled={busyId === item.id}
                    onClick={() => void removeItem(item.id)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>

            {doneCount > 0 && (
              <button
                type="button"
                className="shared-list-clear"
                disabled={busyId === 'clear'}
                onClick={() => void clearDone()}
              >
                Удалить отмеченные ({doneCount})
              </button>
            )}

            <form
              className="shared-list-add"
              onSubmit={(e) => {
                e.preventDefault();
                void addItem();
              }}
            >
              <input
                ref={draftInputRef}
                type="text"
                placeholder="Новый пункт"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                enterKeyHint="next"
                inputMode="text"
              />
              <button
                type="submit"
                className="shared-list-add-btn"
                disabled={!draft.trim()}
                aria-label="Добавить"
                // Keep keyboard open: don't let the button take focus on tap.
                onPointerDown={(e) => e.preventDefault()}
                onMouseDown={(e) => e.preventDefault()}
              >
                +
              </button>
            </form>
            <p className="shared-list-add-hint">Enter или + — следующий пункт</p>
          </>
        )}
      </div>
    </div>
  );
}
