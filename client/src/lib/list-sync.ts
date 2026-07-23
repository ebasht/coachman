import { api, type Chat } from './api';
import { encryptChatShared } from './messages-encrypt';
import {
  addListOutboxItem,
  getChatList,
  getKey,
  getListOutboxItems,
  removeListOutboxItem,
  saveChatList,
  saveKey,
  type ListOutboxItem,
  type StoredChatList,
  type StoredChatListItem,
} from './storage';

function sortItems(items: StoredChatListItem[]) {
  return [...items].sort(
    (a, b) => Number(a.done) - Number(b.done) || a.position - b.position || a.updatedAt - b.updatedAt,
  );
}

export async function persistList(list: StoredChatList) {
  await saveChatList({ ...list, items: sortItems(list.items) });
}

export async function loadCachedList(chatId: string): Promise<StoredChatList | undefined> {
  return getChatList(chatId);
}

export async function getListSeenAt(chatId: string): Promise<number> {
  const raw = await getKey(`listSeenAt:${chatId}`);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}

export async function markListSeen(chatId: string, at = Date.now()): Promise<void> {
  await saveKey(`listSeenAt:${chatId}`, String(at));
  await saveKey(`listUnread:${chatId}`, '0');
}

export async function markListUnread(chatId: string): Promise<void> {
  await saveKey(`listUnread:${chatId}`, '1');
  await saveKey(`listActivityAt:${chatId}`, String(Date.now()));
}

export async function clearListUnread(chatId: string): Promise<void> {
  await markListSeen(chatId);
}

export async function isListUnreadFlag(chatId: string): Promise<boolean> {
  const flag = await getKey(`listUnread:${chatId}`);
  if (flag === '1') return true;
  const [activityRaw, seenAt] = await Promise.all([
    getKey(`listActivityAt:${chatId}`),
    getListSeenAt(chatId),
  ]);
  const activity = activityRaw ? Number(activityRaw) : 0;
  return Number.isFinite(activity) && activity > seenAt;
}

/** Compare remote list updatedAt with last seen; used when opening a chat. */
export async function checkListUnreadFromServer(chatId: string): Promise<boolean> {
  if (await isListUnreadFlag(chatId)) return true;
  const cached = await getChatList(chatId);
  const seenAt = await getListSeenAt(chatId);
  if (cached && cached.updatedAt > seenAt) {
    await markListUnread(chatId);
    return true;
  }
  if (!navigator.onLine) return false;
  try {
    const lists = await api.listChatLists(chatId);
    const updatedAt = lists[0]?.updatedAt ?? 0;
    if (updatedAt > seenAt) {
      await markListUnread(chatId);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

export function listEventActorId(event: {
  actorUserId?: string;
  item?: { updatedByUserId?: string; createdByUserId?: string };
  list?: { createdByUserId?: string };
}): string | undefined {
  return (
    event.actorUserId ||
    event.item?.updatedByUserId ||
    event.item?.createdByUserId ||
    event.list?.createdByUserId
  );
}

export function emptyLocalList(chatId: string): StoredChatList {
  const now = Date.now();
  return {
    id: `local-${chatId}`,
    chatId,
    title: 'Список',
    createdAt: now,
    updatedAt: now,
    items: [],
    localOnly: true,
  };
}

export async function enqueueListOp(item: ListOutboxItem) {
  await addListOutboxItem(item);
}

/** Push queued list mutations when back online. */
export async function flushListOutbox(
  chatsById: Map<string, Chat>,
  userId: string,
  privateKeyB64: string,
): Promise<number> {
  if (!navigator.onLine) return 0;
  const items = await getListOutboxItems();
  let flushed = 0;

  for (const op of items) {
    const chat = chatsById.get(op.chatId);
    if (!chat) continue;

    try {
      let list = await getChatList(op.chatId);

      if (op.kind === 'create-list') {
        const { ciphertext, iv } = await encryptChatShared('Список', chat, userId, privateKeyB64);
        const remote = await api.createChatList(op.chatId, ciphertext, iv);
        if (list) {
          await saveChatList({
            ...list,
            id: remote.id,
            localOnly: false,
            createdAt: remote.createdAt,
            updatedAt: remote.updatedAt,
            items: list.items.map((i) => ({ ...i, listId: remote.id })),
          });
        } else {
          await saveChatList({
            id: remote.id,
            chatId: op.chatId,
            title: 'Список',
            createdAt: remote.createdAt,
            updatedAt: remote.updatedAt,
            items: [],
            localOnly: false,
          });
        }
        await removeListOutboxItem(op.id);
        flushed++;
        continue;
      }

      if (list?.localOnly) {
        const { ciphertext, iv } = await encryptChatShared('Список', chat, userId, privateKeyB64);
        const remote = await api.createChatList(op.chatId, ciphertext, iv);
        list = {
          ...list,
          id: remote.id,
          localOnly: false,
          createdAt: remote.createdAt,
          updatedAt: remote.updatedAt,
          items: list.items.map((i) => ({ ...i, listId: remote.id })),
        };
        await saveChatList(list);
      }

      list = await getChatList(op.chatId);
      if (!list || list.localOnly) continue;
      const listId = list.id;

      if (op.kind === 'add') {
        const localItem = list.items.find((i) => i.id === op.itemId);
        const text = op.text || localItem?.text;
        if (!text) {
          await removeListOutboxItem(op.id);
          continue;
        }
        const { ciphertext, iv } = await encryptChatShared(text, chat, userId, privateKeyB64);
        const remote = await api.addChatListItem(op.chatId, listId, ciphertext, iv);
        list = {
          ...list,
          items: sortItems(
            list.items.map((i) =>
              i.id === op.itemId
                ? { ...i, id: remote.id, listId, pending: false, updatedAt: remote.updatedAt }
                : i,
            ),
          ),
        };
        await saveChatList(list);
      } else if (op.kind === 'toggle') {
        await api.setChatListItemDone(op.chatId, listId, op.itemId, op.done);
      } else if (op.kind === 'delete') {
        try {
          await api.deleteChatListItem(op.chatId, listId, op.itemId);
        } catch {
          // already gone remotely
        }
      } else if (op.kind === 'reorder') {
        await api.reorderChatListItems(op.chatId, listId, op.itemIds);
      }

      await removeListOutboxItem(op.id);
      flushed++;
    } catch {
      // keep in outbox for next attempt
      break;
    }
  }

  return flushed;
}
