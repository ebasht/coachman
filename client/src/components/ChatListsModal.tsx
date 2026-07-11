import { useCallback, useEffect, useState } from 'react';
import { api, type Chat, type RawChatList, type RawChatListItem } from '../lib/api';
import { decryptChatShared, encryptChatShared } from '../lib/messages-encrypt';
import { notify } from '../lib/notify';
import { Notice } from './Notice';

export interface DecryptedListItem {
  id: string;
  listId: string;
  text: string;
  done: boolean;
  position: number;
  updatedAt: number;
}

export interface DecryptedList {
  id: string;
  chatId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  items: DecryptedListItem[];
}

interface Props {
  chat: Chat;
  userId: string;
  privateKeyB64: string;
  listEvent?: ChatListEvent | null;
  onClose: () => void;
}

export type ChatListEvent = {
  action: 'upsert' | 'delete' | 'item_upsert' | 'item_delete';
  chatId: string;
  listId?: string;
  list?: RawChatList;
  item?: RawChatListItem;
  itemId?: string;
};

async function decryptList(
  raw: RawChatList,
  chat: Chat,
  userId: string,
  privateKeyB64: string,
): Promise<DecryptedList> {
  let title = 'Список';
  try {
    title = await decryptChatShared(raw.titleCiphertext, raw.titleIv, chat, userId, privateKeyB64);
  } catch {
    title = '[не удалось расшифровать]';
  }
  const items: DecryptedListItem[] = [];
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
  items.sort((a, b) => a.position - b.position || a.updatedAt - b.updatedAt);
  return {
    id: raw.id,
    chatId: raw.chatId,
    title,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    items,
  };
}

async function decryptItem(
  item: RawChatListItem,
  chat: Chat,
  userId: string,
  privateKeyB64: string,
): Promise<DecryptedListItem> {
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

export function ChatListsModal({ chat, userId, privateKeyB64, listEvent, onClose }: Props) {
  const [lists, setLists] = useState<DecryptedList[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newListTitle, setNewListTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [draftByList, setDraftByList] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const raw = await api.listChatLists(chat.id);
      const decrypted = await Promise.all(raw.map((l) => decryptList(l, chat, userId, privateKeyB64)));
      setLists(decrypted);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить списки');
    } finally {
      setLoading(false);
    }
  }, [chat, userId, privateKeyB64]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!listEvent || listEvent.chatId !== chat.id) return;
    let cancelled = false;

    const apply = async () => {
      if (listEvent.action === 'delete' && listEvent.listId) {
        setLists((prev) => prev.filter((l) => l.id !== listEvent.listId));
        return;
      }
      if (listEvent.action === 'upsert' && listEvent.list) {
        const decrypted = await decryptList(listEvent.list, chat, userId, privateKeyB64);
        if (cancelled) return;
        setLists((prev) => {
          const idx = prev.findIndex((l) => l.id === decrypted.id);
          if (idx === -1) return [...prev, decrypted];
          const next = [...prev];
          next[idx] = { ...decrypted, items: decrypted.items.length ? decrypted.items : next[idx].items };
          return next;
        });
        return;
      }
      if (listEvent.action === 'item_upsert' && listEvent.item && listEvent.listId) {
        const decrypted = await decryptItem(listEvent.item, chat, userId, privateKeyB64);
        if (cancelled) return;
        setLists((prev) =>
          prev.map((l) => {
            if (l.id !== listEvent.listId) return l;
            const idx = l.items.findIndex((i) => i.id === decrypted.id);
            const items = [...l.items];
            if (idx === -1) items.push(decrypted);
            else items[idx] = decrypted;
            items.sort((a, b) => a.position - b.position || a.updatedAt - b.updatedAt);
            return { ...l, items, updatedAt: decrypted.updatedAt };
          }),
        );
        return;
      }
      if (listEvent.action === 'item_delete' && listEvent.listId && listEvent.itemId) {
        setLists((prev) =>
          prev.map((l) =>
            l.id === listEvent.listId
              ? { ...l, items: l.items.filter((i) => i.id !== listEvent.itemId) }
              : l,
          ),
        );
      }
    };

    void apply();
    return () => {
      cancelled = true;
    };
  }, [listEvent, chat, userId, privateKeyB64]);

  const createList = async () => {
    const title = newListTitle.trim();
    if (!title || creating) return;
    setCreating(true);
    try {
      const { ciphertext, iv } = await encryptChatShared(title, chat, userId, privateKeyB64);
      const raw = await api.createChatList(chat.id, ciphertext, iv);
      const decrypted = await decryptList(raw, chat, userId, privateKeyB64);
      setLists((prev) => (prev.some((l) => l.id === decrypted.id) ? prev : [...prev, decrypted]));
      setNewListTitle('');
    } catch (e) {
      notify.error(e instanceof Error ? e.message : 'Не удалось создать список');
    } finally {
      setCreating(false);
    }
  };

  const removeList = async (listId: string) => {
    if (!window.confirm('Удалить список для всех участников чата?')) return;
    setBusyId(listId);
    try {
      await api.deleteChatList(chat.id, listId);
      setLists((prev) => prev.filter((l) => l.id !== listId));
    } catch (e) {
      notify.error(e instanceof Error ? e.message : 'Не удалось удалить список');
    } finally {
      setBusyId(null);
    }
  };

  const addItem = async (listId: string) => {
    const text = (draftByList[listId] || '').trim();
    if (!text) return;
    setBusyId(`add-${listId}`);
    try {
      const { ciphertext, iv } = await encryptChatShared(text, chat, userId, privateKeyB64);
      const raw = await api.addChatListItem(chat.id, listId, ciphertext, iv);
      const decrypted = await decryptItem(raw, chat, userId, privateKeyB64);
      setLists((prev) =>
        prev.map((l) => {
          if (l.id !== listId) return l;
          if (l.items.some((i) => i.id === decrypted.id)) return l;
          return { ...l, items: [...l.items, decrypted] };
        }),
      );
      setDraftByList((prev) => ({ ...prev, [listId]: '' }));
    } catch (e) {
      notify.error(e instanceof Error ? e.message : 'Не удалось добавить пункт');
    } finally {
      setBusyId(null);
    }
  };

  const toggleItem = async (listId: string, item: DecryptedListItem) => {
    setBusyId(item.id);
    const nextDone = !item.done;
    setLists((prev) =>
      prev.map((l) =>
        l.id !== listId
          ? l
          : { ...l, items: l.items.map((i) => (i.id === item.id ? { ...i, done: nextDone } : i)) },
      ),
    );
    try {
      await api.setChatListItemDone(chat.id, listId, item.id, nextDone);
    } catch (e) {
      setLists((prev) =>
        prev.map((l) =>
          l.id !== listId
            ? l
            : { ...l, items: l.items.map((i) => (i.id === item.id ? { ...i, done: item.done } : i)) },
        ),
      );
      notify.error(e instanceof Error ? e.message : 'Не удалось обновить пункт');
    } finally {
      setBusyId(null);
    }
  };

  const removeItem = async (listId: string, itemId: string) => {
    setBusyId(itemId);
    try {
      await api.deleteChatListItem(chat.id, listId, itemId);
      setLists((prev) =>
        prev.map((l) => (l.id === listId ? { ...l, items: l.items.filter((i) => i.id !== itemId) } : l)),
      );
    } catch (e) {
      notify.error(e instanceof Error ? e.message : 'Не удалось удалить пункт');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal chat-lists-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Списки</h2>
        <p className="modal-subtitle">Покупки и дела — видны всем участникам чата</p>

        {error && <Notice variant="error">{error}</Notice>}
        {loading ? (
          <p className="modal-subtitle">Загрузка…</p>
        ) : (
          <div className="chat-lists">
            {lists.length === 0 && (
              <p className="chat-lists-empty">Пока нет списков. Создайте первый.</p>
            )}
            {lists.map((list) => {
              const openCount = list.items.filter((i) => !i.done).length;
              return (
                <section key={list.id} className="chat-list-card">
                  <header className="chat-list-card-header">
                    <div>
                      <h3>{list.title}</h3>
                      <span className="chat-list-meta">
                        {list.items.length === 0
                          ? 'Пусто'
                          : openCount === 0
                            ? 'Всё отмечено'
                            : `Осталось: ${openCount}`}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="link-btn danger"
                      disabled={busyId === list.id}
                      onClick={() => void removeList(list.id)}
                    >
                      Удалить
                    </button>
                  </header>
                  <ul className="chat-list-items">
                    {list.items.map((item) => (
                      <li key={item.id} className={item.done ? 'done' : ''}>
                        <label>
                          <input
                            type="checkbox"
                            checked={item.done}
                            disabled={busyId === item.id}
                            onChange={() => void toggleItem(list.id, item)}
                          />
                          <span>{item.text}</span>
                        </label>
                        <button
                          type="button"
                          className="chat-list-item-remove"
                          aria-label="Удалить пункт"
                          disabled={busyId === item.id}
                          onClick={() => void removeItem(list.id, item.id)}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                  <form
                    className="chat-list-add"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void addItem(list.id);
                    }}
                  >
                    <input
                      type="text"
                      placeholder="Новый пункт"
                      value={draftByList[list.id] || ''}
                      onChange={(e) =>
                        setDraftByList((prev) => ({ ...prev, [list.id]: e.target.value }))
                      }
                      autoComplete="off"
                    />
                    <button type="submit" disabled={busyId === `add-${list.id}` || !(draftByList[list.id] || '').trim()}>
                      Добавить
                    </button>
                  </form>
                </section>
              );
            })}
          </div>
        )}

        <form
          className="chat-list-create"
          onSubmit={(e) => {
            e.preventDefault();
            void createList();
          }}
        >
          <input
            type="text"
            placeholder="Название списка (Покупки, Дела…)"
            value={newListTitle}
            onChange={(e) => setNewListTitle(e.target.value)}
            autoComplete="off"
          />
          <button type="submit" disabled={creating || !newListTitle.trim()}>
            Создать список
          </button>
        </form>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
