import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export interface StoredMessage {
  id: string;
  chatId: string;
  senderId: string;
  senderName: string;
  text: string;
  type: 'text' | 'image' | 'call' | 'list';
  imageUrl?: string;
  imageId?: string;
  /** Stable client-generated id used for outbox idempotency / UI dedupe. */
  clientId?: string;
  createdAt: number;
  pending?: boolean;
}

export interface StoredChat {
  id: string;
  type: 'direct' | 'group';
  displayName: string;
  isSystem?: boolean;
  groupKeyEpoch?: number;
  members: {
    id: string;
    username: string;
    publicKey: string;
    isAdmin?: boolean;
    hasAvatar?: boolean;
    avatarUpdatedAt?: number;
    avatarUrl?: string;
    encryptedGroupKey?: string;
  }[];
  lastMessageAt?: number;
  lastMessage?: { id: string; senderId: string; type: string; createdAt: number };
  peerLastReadAt?: number;
  createdAt?: number;
}

export interface LocalAccount {
  userId: string;
  username: string;
  publicKey: string;
  isAdmin?: boolean;
  privateKey?: string;
  signingPublicKey?: string;
  signingPrivateKey?: string;
  encryptedPrivateKey?: { salt: string; iv: string; ciphertext: string };
  encryptedSigningPrivateKey?: { salt: string; iv: string; ciphertext: string };
}

export type OutboxItem =
  | {
      id: string;
      chatId: string;
      tempMessageId: string;
      kind: 'text';
      ciphertext: string;
      iv: string;
      plainText: string;
      createdAt: number;
    }
  | {
      id: string;
      chatId: string;
      tempMessageId: string;
      kind: 'call' | 'list';
      ciphertext: string;
      iv: string;
      plainText: string;
      pushBody: string;
      createdAt: number;
    }
  | {
      id: string;
      chatId: string;
      tempMessageId: string;
      kind: 'image';
      imageCiphertext: ArrayBuffer;
      imageIv: string;
      imageMimeType: string;
      msgCiphertext: string;
      msgIv: string;
      previewData: ArrayBuffer;
      previewMimeType: string;
      createdAt: number;
      /** Set after a successful upload so retries skip re-upload if only sendMessage failed. */
      uploadedImageId?: string;
    };

export interface CachedImage {
  data: ArrayBuffer;
  mimeType: string;
}

interface MsgDB extends DBSchema {
  messages: {
    key: string;
    value: StoredMessage;
    indexes: { 'by-chat': string };
  };
  chats: {
    key: string;
    value: StoredChat;
  };
  keys: {
    key: string;
    value: string;
  };
  accounts: {
    key: string;
    value: LocalAccount;
  };
  outbox: {
    key: string;
    value: OutboxItem;
    indexes: { 'by-created': number };
  };
  imageCache: {
    key: string;
    value: CachedImage;
  };
  chatLists: {
    key: string;
    value: StoredChatList;
  };
  listOutbox: {
    key: string;
    value: ListOutboxItem;
    indexes: { 'by-created': number };
  };
}

export interface StoredChatListItem {
  id: string;
  listId: string;
  text: string;
  done: boolean;
  position: number;
  updatedAt: number;
  pending?: boolean;
}

export interface StoredChatList {
  id: string;
  chatId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  items: StoredChatListItem[];
  localOnly?: boolean;
}

export type ListOutboxItem =
  | {
      id: string;
      chatId: string;
      listId: string;
      kind: 'add';
      itemId: string;
      text: string;
      createdAt: number;
    }
  | {
      id: string;
      chatId: string;
      listId: string;
      kind: 'toggle';
      itemId: string;
      done: boolean;
      createdAt: number;
    }
  | {
      id: string;
      chatId: string;
      listId: string;
      kind: 'delete';
      itemId: string;
      createdAt: number;
    }
  | {
      id: string;
      chatId: string;
      listId: string;
      kind: 'create-list';
      createdAt: number;
    };

let dbPromise: Promise<IDBPDatabase<MsgDB>> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<MsgDB>('coachman', 4, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const msgStore = db.createObjectStore('messages', { keyPath: 'id' });
          msgStore.createIndex('by-chat', 'chatId');
          db.createObjectStore('chats', { keyPath: 'id' });
          db.createObjectStore('keys');
        }
        if (oldVersion < 2) {
          db.createObjectStore('accounts', { keyPath: 'userId' });
        }
        if (oldVersion < 3) {
          const outbox = db.createObjectStore('outbox', { keyPath: 'id' });
          outbox.createIndex('by-created', 'createdAt');
          db.createObjectStore('imageCache');
        }
        if (oldVersion < 4) {
          db.createObjectStore('chatLists', { keyPath: 'chatId' });
          const listOutbox = db.createObjectStore('listOutbox', { keyPath: 'id' });
          listOutbox.createIndex('by-created', 'createdAt');
        }
      },
    });
  }
  return dbPromise;
}

export async function saveMessage(msg: StoredMessage) {
  const db = await getDB();
  const { imageUrl: _imageUrl, ...stored } = msg;
  await db.put('messages', stored);

  const chat = await db.get('chats', msg.chatId);
  if (!chat) return;
  if (!chat.lastMessageAt || msg.createdAt >= chat.lastMessageAt) {
    await db.put('chats', {
      ...chat,
      lastMessageAt: msg.createdAt,
      lastMessage: msg.pending
        ? chat.lastMessage
        : {
            id: msg.id,
            senderId: msg.senderId,
            type: msg.type,
            createdAt: msg.createdAt,
          },
    });
  }
}

export async function getMessages(chatId: string): Promise<StoredMessage[]> {
  const db = await getDB();
  return db.getAllFromIndex('messages', 'by-chat', chatId);
}

export async function deleteMessageLocal(messageId: string, chatId: string) {
  const db = await getDB();
  await db.delete('messages', messageId);

  const chat = await db.get('chats', chatId);
  if (!chat?.lastMessage || chat.lastMessage.id !== messageId) return;

  const remaining = (await db.getAllFromIndex('messages', 'by-chat', chatId))
    .filter((m) => !m.pending)
    .sort((a, b) => b.createdAt - a.createdAt);
  const latest = remaining[0];
  await db.put('chats', {
    ...chat,
    lastMessageAt: latest?.createdAt,
    lastMessage: latest
      ? { id: latest.id, senderId: latest.senderId, type: latest.type, createdAt: latest.createdAt }
      : undefined,
  });
}

export async function saveChat(chat: StoredChat) {
  const db = await getDB();
  await db.put('chats', chat);
}

export async function updateChatPeerReadAt(chatId: string, at: number) {
  const db = await getDB();
  const chat = await db.get('chats', chatId);
  if (!chat) return;
  const next = Math.max(chat.peerLastReadAt ?? 0, at);
  if (next === chat.peerLastReadAt) return;
  await db.put('chats', { ...chat, peerLastReadAt: next });
}

export async function getChats(): Promise<StoredChat[]> {
  const db = await getDB();
  return db.getAll('chats');
}

export async function getMessageChatIds(): Promise<string[]> {
  const db = await getDB();
  const messages = await db.getAll('messages');
  return [...new Set(messages.map((m) => m.chatId))];
}

export async function saveKey(id: string, value: string) {
  const db = await getDB();
  await db.put('keys', value, id);
}

export async function getKey(id: string): Promise<string | undefined> {
  const db = await getDB();
  return db.get('keys', id);
}

export async function deleteKey(id: string) {
  const db = await getDB();
  await db.delete('keys', id);
}

export async function savePrivateKey(b64: string) {
  return saveKey('privateKey', b64);
}

export async function loadPrivateKey(): Promise<string | undefined> {
  return getKey('privateKey');
}

export async function saveUserId(id: string) {
  return saveKey('userId', id);
}

export async function loadUserId(): Promise<string | undefined> {
  return getKey('userId');
}

export async function saveUsername(name: string) {
  return saveKey('username', name);
}

export async function loadUsername(): Promise<string | undefined> {
  return getKey('username');
}

export async function savePublicKey(b64: string) {
  return saveKey('publicKey', b64);
}

export async function loadPublicKey(): Promise<string | undefined> {
  return getKey('publicKey');
}

/** Group AES keys are per-user — shared chatId must not leak keys across accounts on one device. */
function groupKeyId(userId: string, chatId: string) {
  return `groupKey:${userId}:${chatId}`;
}
function groupKeyEpochId(userId: string, chatId: string) {
  return `groupKeyEpoch:${userId}:${chatId}`;
}
function groupKeyArchiveId(userId: string, chatId: string) {
  return `groupKeyArchive:${userId}:${chatId}`;
}

export async function saveGroupKey(userId: string, chatId: string, keyB64: string) {
  return saveKey(groupKeyId(userId, chatId), keyB64);
}

export async function loadGroupKey(userId: string, chatId: string): Promise<string | undefined> {
  const scoped = await getKey(groupKeyId(userId, chatId));
  if (scoped) return scoped;
  // Legacy unscoped key (single-account devices). Migrate once; do not share across users.
  const legacy = await getKey(`groupKey:${chatId}`);
  if (!legacy) return undefined;
  await saveKey(groupKeyId(userId, chatId), legacy);
  const db = await getDB();
  await db.delete('keys', `groupKey:${chatId}`);
  const legacyEpoch = await getKey(`groupKeyEpoch:${chatId}`);
  if (legacyEpoch) {
    await saveKey(groupKeyEpochId(userId, chatId), legacyEpoch);
    await db.delete('keys', `groupKeyEpoch:${chatId}`);
  }
  const legacyArchive = await getKey(`groupKeyArchive:${chatId}`);
  if (legacyArchive) {
    await saveKey(groupKeyArchiveId(userId, chatId), legacyArchive);
    await db.delete('keys', `groupKeyArchive:${chatId}`);
  }
  return legacy;
}

export async function saveGroupKeyEpoch(userId: string, chatId: string, epoch: number) {
  return saveKey(groupKeyEpochId(userId, chatId), String(epoch));
}

export async function loadGroupKeyEpoch(userId: string, chatId: string): Promise<number | undefined> {
  const raw = await getKey(groupKeyEpochId(userId, chatId));
  if (raw) return Number(raw);
  // Trigger legacy migrate via loadGroupKey when present.
  await loadGroupKey(userId, chatId);
  const again = await getKey(groupKeyEpochId(userId, chatId));
  return again ? Number(again) : undefined;
}

export async function loadGroupKeyArchive(userId: string, chatId: string): Promise<Record<number, string>> {
  let raw = await getKey(groupKeyArchiveId(userId, chatId));
  if (!raw) {
    await loadGroupKey(userId, chatId);
    raw = await getKey(groupKeyArchiveId(userId, chatId));
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<number, string>;
  } catch {
    return {};
  }
}

export async function archiveGroupKey(
  userId: string,
  chatId: string,
  epoch: number,
  keyB64: string,
) {
  const archive = await loadGroupKeyArchive(userId, chatId);
  if (archive[epoch] && archive[epoch] !== keyB64) {
    // Keep both keys when epoch collides (stale local key vs server wrap).
    let slot = epoch + 100_000;
    while (archive[slot] && archive[slot] !== keyB64) slot += 1;
    archive[slot] = keyB64;
  } else {
    archive[epoch] = keyB64;
  }
  await saveKey(groupKeyArchiveId(userId, chatId), JSON.stringify(archive));
}

export async function saveGroupKeyWithEpoch(
  userId: string,
  chatId: string,
  keyB64: string,
  epoch: number,
) {
  const oldKey = await loadGroupKey(userId, chatId);
  const oldEpoch = await loadGroupKeyEpoch(userId, chatId);
  if (oldKey && oldKey !== keyB64) {
    await archiveGroupKey(userId, chatId, oldEpoch ?? epoch, oldKey);
  }
  await saveGroupKey(userId, chatId, keyB64);
  await saveGroupKeyEpoch(userId, chatId, epoch);
}

export async function deleteGroupKey(userId: string, chatId: string) {
  const db = await getDB();
  await db.delete('keys', groupKeyId(userId, chatId));
  await db.delete('keys', groupKeyEpochId(userId, chatId));
  await db.delete('keys', groupKeyArchiveId(userId, chatId));
  // Legacy unscoped (pre multi-account).
  await db.delete('keys', `groupKey:${chatId}`);
  await db.delete('keys', `groupKeyEpoch:${chatId}`);
  await db.delete('keys', `groupKeyArchive:${chatId}`);
}

export async function clearChatMessagesLocal(
  chatId: string,
  options?: { dropOutbox?: boolean; reinstateUserId?: string },
) {
  const db = await getDB();
  const messages = await getMessages(chatId);
  for (const msg of messages) {
    await db.delete('messages', msg.id);
    if (msg.imageId) {
      await db.delete('imageCache', msg.imageId);
    }
    await db.delete('imageCache', `local:${msg.id}`);
  }
  const outbox = await getOutboxItems();
  if (options?.dropOutbox) {
    for (const item of outbox) {
      if (item.chatId === chatId) {
        await removeOutboxItem(item.id);
      }
    }
    return;
  }
  // Remote clear / sync wipe must NEVER destroy unsent ciphertext.
  if (options?.reinstateUserId) {
    await reinstatePendingFromOutbox(chatId, options.reinstateUserId);
  }
}

/** Rebuild pending UI rows for durable outbox items after a chat message wipe. */
export async function reinstatePendingFromOutbox(chatId: string, userId: string): Promise<void> {
  const items = (await getOutboxItems()).filter((item) => item.chatId === chatId);
  if (items.length === 0) return;
  const existingIds = new Set((await getMessages(chatId)).map((m) => m.id));

  for (const item of items) {
    if (existingIds.has(item.tempMessageId)) continue;

    if (item.kind === 'image') {
      if (item.previewData?.byteLength) {
        await saveCachedImage(`local:${item.tempMessageId}`, item.previewData.slice(0), item.previewMimeType);
      }
      await saveMessage({
        id: item.tempMessageId,
        chatId,
        senderId: userId,
        senderName: 'Я',
        text: '📷 Изображение',
        type: 'image',
        clientId: item.tempMessageId,
        createdAt: item.createdAt,
        pending: true,
      });
      continue;
    }

    await saveMessage({
      id: item.tempMessageId,
      chatId,
      senderId: userId,
      senderName: 'Я',
      text: item.plainText,
      type: item.kind === 'text' ? 'text' : item.kind,
      clientId: item.tempMessageId,
      createdAt: item.createdAt,
      pending: true,
    });
  }
}

export async function deleteChatLocal(chatId: string, userId?: string) {
  await clearChatMessagesLocal(chatId, { dropOutbox: true });
  const db = await getDB();
  await db.delete('chats', chatId);
  if (userId) await deleteGroupKey(userId, chatId);
  if (userId) {
    await deleteKey(`readAt:${userId}:${chatId}`);
  }
}

export async function saveLocalAccount(account: LocalAccount) {
  const db = await getDB();
  await db.put('accounts', account);
}

export async function getLocalAccounts(): Promise<LocalAccount[]> {
  const db = await getDB();
  const accounts = await db.getAll('accounts');
  return accounts.sort((a, b) => a.username.localeCompare(b.username));
}

export async function getLocalAccountByUserId(userId: string): Promise<LocalAccount | undefined> {
  const db = await getDB();
  return db.get('accounts', userId);
}

export async function getLocalAccountByUsername(username: string): Promise<LocalAccount | undefined> {
  const normalized = username.trim().toLowerCase();
  const accounts = await getLocalAccounts();
  return accounts.find((a) => a.username.toLowerCase() === normalized);
}

export async function saveLastActiveUserId(userId: string) {
  return saveKey('lastActiveUserId', userId);
}

export async function loadLastActiveUserId(): Promise<string | undefined> {
  return getKey('lastActiveUserId');
}

export async function migrateLegacyKeys() {
  const userId = await loadUserId();
  const username = await loadUsername();
  const publicKey = await loadPublicKey();
  const privateKey = await loadPrivateKey();
  if (!userId || !username || !publicKey || !privateKey) return;

  await saveLocalAccount({ userId, username, publicKey, privateKey });
  await saveLastActiveUserId(userId);
}

/** Remove pre-multi-account group key rows (`groupKey:<chatId>` without userId). */
export async function purgeLegacyUnscopedGroupKeys() {
  const db = await getDB();
  const allKeys = await db.getAllKeys('keys');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const key of allKeys) {
    if (typeof key !== 'string') continue;
    for (const prefix of ['groupKey:', 'groupKeyEpoch:', 'groupKeyArchive:'] as const) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      // Scoped keys are userId:chatId — legacy is chatId only.
      if (uuid.test(rest)) {
        await db.delete('keys', key);
      }
    }
  }
}

/** Wipe per-account local data when logging out or switching accounts on one device. */
export async function clearSession() {
  const db = await getDB();
  await db.clear('messages');
  await db.clear('chats');
  await db.clear('outbox');
  await db.clear('imageCache');
  await db.clear('chatLists');
  await db.clear('listOutbox');
  await db.delete('keys', 'lastActiveUserId');

  const allKeys = await db.getAllKeys('keys');
  for (const key of allKeys) {
    // groupKey / groupKeyEpoch / groupKeyArchive (scoped and legacy)
    if (typeof key === 'string' && key.startsWith('groupKey')) {
      await db.delete('keys', key);
    }
  }
  try {
    const healKeys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k?.startsWith('sysheal:')) healKeys.push(k);
    }
    for (const k of healKeys) sessionStorage.removeItem(k);
  } catch {
    /* private mode */
  }
}

export async function removeLocalAccount(userId: string) {
  const db = await getDB();
  await db.delete('accounts', userId);
  const lastId = await loadLastActiveUserId();
  if (lastId === userId) {
    await db.delete('keys', 'lastActiveUserId');
  }
}

export async function addOutboxItem(item: OutboxItem) {
  const db = await getDB();
  await db.put('outbox', item);
}

export async function getOutboxItems(): Promise<OutboxItem[]> {
  const db = await getDB();
  const items = await db.getAllFromIndex('outbox', 'by-created');
  return items.sort((a, b) => a.createdAt - b.createdAt);
}

export async function removeOutboxItem(id: string) {
  const db = await getDB();
  await db.delete('outbox', id);
}

export async function removeOutboxByTempMessageId(tempMessageId: string): Promise<boolean> {
  const items = await getOutboxItems();
  const match = items.find((item) => item.tempMessageId === tempMessageId);
  if (!match) return false;
  await removeOutboxItem(match.id);
  return true;
}

export async function replacePendingMessage(tempId: string, message: StoredMessage) {
  const db = await getDB();
  await db.delete('messages', tempId);
  await saveMessage({ ...message, pending: false });
}

export async function saveCachedImage(imageId: string, data: ArrayBuffer, mimeType: string) {
  const db = await getDB();
  await db.put('imageCache', { data, mimeType }, imageId);
}

export async function getCachedImage(imageId: string): Promise<CachedImage | undefined> {
  const db = await getDB();
  return db.get('imageCache', imageId);
}

export async function saveChatList(list: StoredChatList) {
  const db = await getDB();
  await db.put('chatLists', list);
}

export async function getChatList(chatId: string): Promise<StoredChatList | undefined> {
  const db = await getDB();
  return db.get('chatLists', chatId);
}

export async function deleteChatListLocal(chatId: string) {
  const db = await getDB();
  await db.delete('chatLists', chatId);
}

export async function addListOutboxItem(item: ListOutboxItem) {
  const db = await getDB();
  await db.put('listOutbox', item);
}

export async function getListOutboxItems(): Promise<ListOutboxItem[]> {
  const db = await getDB();
  return db.getAllFromIndex('listOutbox', 'by-created');
}

export async function removeListOutboxItem(id: string) {
  const db = await getDB();
  await db.delete('listOutbox', id);
}
