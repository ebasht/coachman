import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export interface StoredMessage {
  id: string;
  chatId: string;
  senderId: string;
  senderName: string;
  text: string;
  type: 'text' | 'image';
  imageUrl?: string;
  imageId?: string;
  createdAt: number;
  pending?: boolean;
}

export interface StoredChat {
  id: string;
  type: 'direct' | 'group';
  displayName: string;
  members: { id: string; username: string; publicKey: string; encryptedGroupKey?: string }[];
  lastMessageAt?: number;
  lastMessage?: { id: string; senderId: string; type: string; createdAt: number };
  createdAt?: number;
}

export interface LocalAccount {
  userId: string;
  username: string;
  publicKey: string;
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
      kind: 'image';
      imageCiphertext: ArrayBuffer;
      imageIv: string;
      imageMimeType: string;
      msgCiphertext: string;
      msgIv: string;
      previewData: ArrayBuffer;
      previewMimeType: string;
      createdAt: number;
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
}

let dbPromise: Promise<IDBPDatabase<MsgDB>> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<MsgDB>('coachman', 3, {
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

export async function saveChat(chat: StoredChat) {
  const db = await getDB();
  await db.put('chats', chat);
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

export async function saveGroupKey(chatId: string, keyB64: string) {
  return saveKey(`groupKey:${chatId}`, keyB64);
}

export async function loadGroupKey(chatId: string): Promise<string | undefined> {
  return getKey(`groupKey:${chatId}`);
}

export async function saveGroupKeyEpoch(chatId: string, epoch: number) {
  return saveKey(`groupKeyEpoch:${chatId}`, String(epoch));
}

export async function loadGroupKeyEpoch(chatId: string): Promise<number | undefined> {
  const raw = await getKey(`groupKeyEpoch:${chatId}`);
  return raw ? Number(raw) : undefined;
}

export async function loadGroupKeyArchive(chatId: string): Promise<Record<number, string>> {
  const raw = await getKey(`groupKeyArchive:${chatId}`);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<number, string>;
  } catch {
    return {};
  }
}

export async function archiveGroupKey(chatId: string, epoch: number, keyB64: string) {
  const archive = await loadGroupKeyArchive(chatId);
  archive[epoch] = keyB64;
  await saveKey(`groupKeyArchive:${chatId}`, JSON.stringify(archive));
}

export async function saveGroupKeyWithEpoch(chatId: string, keyB64: string, epoch: number) {
  const oldKey = await loadGroupKey(chatId);
  const oldEpoch = await loadGroupKeyEpoch(chatId);
  if (oldKey && oldEpoch) {
    await archiveGroupKey(chatId, oldEpoch, oldKey);
  }
  await saveGroupKey(chatId, keyB64);
  await saveGroupKeyEpoch(chatId, epoch);
}

export async function deleteGroupKey(chatId: string) {
  const db = await getDB();
  await db.delete('keys', `groupKey:${chatId}`);
  await db.delete('keys', `groupKeyEpoch:${chatId}`);
  await db.delete('keys', `groupKeyArchive:${chatId}`);
}

export async function deleteChatLocal(chatId: string, userId?: string) {
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
  for (const item of outbox) {
    if (item.chatId === chatId) {
      await removeOutboxItem(item.id);
    }
  }
  await db.delete('chats', chatId);
  await deleteGroupKey(chatId);
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

export async function clearSession() {
  const db = await getDB();
  await db.clear('messages');
  await db.clear('chats');
  await db.delete('keys', 'lastActiveUserId');

  const allKeys = await db.getAllKeys('keys');
  for (const key of allKeys) {
    if (typeof key === 'string' && key.startsWith('groupKey:')) {
      await db.delete('keys', key);
    }
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
