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
    title = 'Список';
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
  items.sort((a, b) => Number(a.done) - Number(b.done) || a.position - b.position || a.updatedAt - b.updatedAt);
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

function sortItems(items: DecryptedListItem[]) {
  return [...items].sort(
    (a, b) => Number(a.done) - Number(b.done) || a.position - b.position || a.updatedAt - b.updatedAt,
  );
}

export function ChatListsModal({ chat, userId, privateKeyB64, listEvent, onClose }: Props) {
  const [list, setList] = useState<DecryptedList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const ensureList = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const rawLists = await api.listChatLists(chat.id);
      if (rawLists.length > 0) {
        setList(await decryptList(rawLists[0], chat, userId, privateKeyB64));
        return;
      }
      const { ciphertext, iv } = await encryptChatShared('Список', chat, userId, privateKeyB64);
      const raw = await api.createChatList(chat.id, ciphertext, iv);
      setList(await decryptList(raw, chat, userId, privateKeyB64));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить список');
    } finally {
      setLoading(false);
    }
  }, [chat, userId, privateKeyB64]);

  useEffect(() => {
    void ensureList();
  }, [ensureList]);

  useEffect(() => {
    if (!listEvent || listEvent.chatId !== chat.id) return;
    let cancelled = false;

    const apply = async () => {
      if (listEvent.action === 'delete' && listEvent.listId) {
        setList((prev) => (prev?.id === listEvent.listId ? null : prev));
        void ensureList();
        return;
      }
      if (listEvent.action === 'upsert' && listEvent.list) {
        const decrypted = await decryptList(listEvent.list, chat, userId, privateKeyB64);
        if (cancelled) return;
        setList((prev) => {
          if (prev && prev.id !== decrypted.id) return prev;
          return {
            ...decrypted,
            items: decrypted.items.length ? decrypted.items : prev?.items ?? [],
          };
        });
        return;
      }
      if (listEvent.action === 'item_upsert' && listEvent.item && listEvent.listId) {
        const decrypted = await decryptItem(listEvent.item, chat, userId, privateKeyB64);
        if (cancelled) return;
        setList((prev) => {
          if (!prev || prev.id !== listEvent.listId) return prev;
          const idx = prev.items.findIndex((i) => i.id === decrypted.id);
          const items = [...prev.items];
          if (idx === -1) items.push(decrypted);
          else items[idx] = decrypted;
          return { ...prev, items: sortItems(items), updatedAt: decrypted.updatedAt };
        });
        return;
      }
      if (listEvent.action === 'item_delete' && listEvent.listId && listEvent.itemId) {
        setList((prev) =>
          prev && prev.id === listEvent.listId
            ? { ...prev, items: prev.items.filter((i) => i.id !== listEvent.itemId) }
            : prev,
        );
      }
    };

    void apply();
    return () => {
      cancelled = true;
    };
  }, [listEvent, chat, userId, privateKeyB64, ensureList]);

  const addItem = async () => {
    if (!list) return;
    const text = draft.trim();
    if (!text) return;
    setBusyId('add');
    try {
      const { ciphertext, iv } = await encryptChatShared(text, chat, userId, privateKeyB64);
      const raw = await api.addChatListItem(chat.id, list.id, ciphertext, iv);
      const decrypted = await decryptItem(raw, chat, userId, privateKeyB64);
      setList((prev) => {
        if (!prev || prev.items.some((i) => i.id === decrypted.id)) return prev;
        return { ...prev, items: sortItems([...prev.items, decrypted]) };
      });
      setDraft('');
    } catch (e) {
      notify.error(e instanceof Error ? e.message : 'Не удалось добавить');
    } finally {
      setBusyId(null);
    }
  };

  const toggleItem = async (item: DecryptedListItem) => {
    if (!list) return;
    setBusyId(item.id);
    const nextDone = !item.done;
    setList((prev) =>
      prev
        ? { ...prev, items: sortItems(prev.items.map((i) => (i.id === item.id ? { ...i, done: nextDone } : i))) }
        : prev,
    );
    try {
      await api.setChatListItemDone(chat.id, list.id, item.id, nextDone);
    } catch (e) {
      setList((prev) =>
        prev
          ? { ...prev, items: sortItems(prev.items.map((i) => (i.id === item.id ? { ...i, done: item.done } : i))) }
          : prev,
      );
      notify.error(e instanceof Error ? e.message : 'Не удалось обновить');
    } finally {
      setBusyId(null);
    }
  };

  const removeItem = async (itemId: string) => {
    if (!list) return;
    setBusyId(itemId);
    try {
      await api.deleteChatListItem(chat.id, list.id, itemId);
      setList((prev) => (prev ? { ...prev, items: prev.items.filter((i) => i.id !== itemId) } : prev));
    } catch (e) {
      notify.error(e instanceof Error ? e.message : 'Не удалось удалить');
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
    try {
      await Promise.all(done.map((i) => api.deleteChatListItem(chat.id, list.id, i.id)));
      setList((prev) => (prev ? { ...prev, items: prev.items.filter((i) => !i.done) } : prev));
    } catch (e) {
      notify.error(e instanceof Error ? e.message : 'Не удалось очистить');
      void ensureList();
    } finally {
      setBusyId(null);
    }
  };

  const openCount = list?.items.filter((i) => !i.done).length ?? 0;
  const doneCount = list?.items.filter((i) => i.done).length ?? 0;

  return (
    <div className="modal-overlay shared-list-overlay" onClick={onClose}>
      <div className="modal shared-list-modal" onClick={(e) => e.stopPropagation()}>
        <header className="shared-list-header">
          <div>
            <h2>Список</h2>
            {!loading && list && (
              <p className="shared-list-meta">
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

        {error && <Notice variant="error">{error}</Notice>}

        {loading || !list ? (
          <p className="shared-list-empty">Загрузка…</p>
        ) : (
          <>
            <ul className="shared-list-items">
              {list.items.length === 0 && (
                <li className="shared-list-empty-row">Добавьте покупки или дела</li>
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
                type="text"
                placeholder="Новый пункт"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                autoComplete="off"
                enterKeyHint="done"
              />
              <button type="submit" disabled={busyId === 'add' || !draft.trim()} aria-label="Добавить">
                +
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
