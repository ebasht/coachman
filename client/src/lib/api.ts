const API = '/api';
const REQUEST_TIMEOUT_MS = 20_000;
const OFFLINE_TIMEOUT_MS = 4_000;

let authToken: string | null = null;
let authTokenLoader: (() => Promise<string | null>) | null = null;
let authRefresher: (() => Promise<boolean>) | null = null;
let refreshingAuth = false;

export function setAuthToken(token: string | null) {
  authToken = token;
}

export function getAuthToken() {
  return authToken;
}

export function setAuthTokenLoader(loader: (() => Promise<string | null>) | null) {
  authTokenLoader = loader;
}

export function setAuthRefresher(fn: (() => Promise<boolean>) | null) {
  authRefresher = fn;
}

async function ensureAuthToken(): Promise<string | null> {
  if (authToken) return authToken;
  if (!authTokenLoader) return null;
  const loaded = await authTokenLoader();
  if (loaded) {
    authToken = loaded;
    return loaded;
  }
  return null;
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = typeof navigator !== 'undefined' && !navigator.onLine ? OFFLINE_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Превышено время ожидания ответа сервера');
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

async function request<T>(path: string, options?: RequestInit, retried = false): Promise<T> {
  await ensureAuthToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string>),
  };
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const res = await fetchWithTimeout(`${API}${path}`, { ...options, headers });

  if (res.status === 401 && !retried && authRefresher && !refreshingAuth) {
    refreshingAuth = true;
    try {
      const ok = await authRefresher();
      if (ok) return request<T>(path, options, true);
    } finally {
      refreshingAuth = false;
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error: string }).error || 'Request failed');
  }
  return res.json();
}

async function uploadWithAuth(
  chatId: string,
  form: FormData,
  retried = false,
): Promise<{ id: string }> {
  await ensureAuthToken();
  const headers: Record<string, string> = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const res = await fetchWithTimeout(`${API}/chats/${chatId}/images`, {
    method: 'POST',
    body: form,
    headers,
  });

  if (res.status === 401 && !retried && authRefresher && !refreshingAuth) {
    refreshingAuth = true;
    try {
      const ok = await authRefresher();
      if (ok) return uploadWithAuth(chatId, form, true);
    } finally {
      refreshingAuth = false;
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const raw = ((err as { error?: string }).error || res.statusText || '').toLowerCase();
    if (res.status === 413 || raw.includes('entity too large') || raw.includes('too large')) {
      throw new Error('Фото слишком большое для загрузки. Попробуйте другое или сделайте снимок с меньшим разрешением.');
    }
    throw new Error((err as { error: string }).error || 'Не удалось загрузить фото');
  }
  return res.json() as Promise<{ id: string }>;
}

async function uploadAvatarWithAuth(
  form: FormData,
  retried = false,
): Promise<{ hasAvatar: boolean; avatarUpdatedAt: number; avatarUrl?: string }> {
  await ensureAuthToken();
  const headers: Record<string, string> = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const res = await fetchWithTimeout(`${API}/users/me/avatar`, {
    method: 'POST',
    body: form,
    headers,
  });

  if (res.status === 401 && !retried && authRefresher && !refreshingAuth) {
    refreshingAuth = true;
    try {
      const ok = await authRefresher();
      if (ok) return uploadAvatarWithAuth(form, true);
    } finally {
      refreshingAuth = false;
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const raw = ((err as { error?: string }).error || res.statusText || '').toLowerCase();
    if (res.status === 413 || raw.includes('entity too large') || raw.includes('too large')) {
      throw new Error('Фото слишком большое. Выберите другое изображение.');
    }
    throw new Error((err as { error: string }).error || 'Не удалось загрузить аватар');
  }
  return res.json() as Promise<{ hasAvatar: boolean; avatarUpdatedAt: number; avatarUrl?: string }>;
}

async function fetchBlobWithAuth(path: string, retried = false): Promise<Blob> {
  await ensureAuthToken();
  const headers: Record<string, string> = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const res = await fetchWithTimeout(`${API}${path}`, { headers });

  if (res.status === 401 && !retried && authRefresher && !refreshingAuth) {
    refreshingAuth = true;
    try {
      const ok = await authRefresher();
      if (ok) return fetchBlobWithAuth(path, true);
    } finally {
      refreshingAuth = false;
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error: string }).error || 'Request failed');
  }
  return res.blob();
}

export interface User {
  id: string;
  username: string;
  publicKey: string;
  isAdmin?: boolean;
  hasAvatar?: boolean;
  avatarUpdatedAt?: number;
  avatarUrl?: string;
}

export interface InviteInfo {
  token: string;
  inviterUsername: string;
  reservedUsername: string;
  expiresAt?: number;
}

export interface AdminUser {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: number;
}

export interface ChatMember {
  id: string;
  username: string;
  publicKey: string;
  isAdmin?: boolean;
  hasAvatar?: boolean;
  avatarUpdatedAt?: number;
  avatarUrl?: string;
  encryptedGroupKey?: string;
  online?: boolean;
  lastSeenAt?: number;
}

export interface Chat {
  id: string;
  type: 'direct' | 'group';
  name: string | null;
  displayName: string;
  createdByUserId?: string;
  groupKeyEpoch?: number;
  isSystem?: boolean;
  members: ChatMember[];
  lastMessage: { id: string; senderId: string; type: string; createdAt: number } | null;
  lastMessagePreview?: string;
  peerLastReadAt?: number;
  createdAt: number;
}

export interface RawMessage {
  id: string;
  chatId: string;
  senderId: string;
  ciphertext: string;
  iv: string;
  type: 'text' | 'image';
  imageId?: string;
  createdAt: number;
}

export const api = {
  getSetupStatus: () =>
    request<{ hasUsers: boolean; needsBootstrap: boolean }>('/auth/setup-status'),

  bootstrapReset: (bootstrapToken: string) =>
    request<{ status: string; needsBootstrap: boolean }>('/auth/bootstrap-reset', {
      method: 'POST',
      body: JSON.stringify({ bootstrapToken }),
    }),

  validateInvite: (token: string) =>
    request<InviteInfo>(`/invites/validate?token=${encodeURIComponent(token)}`),

  register: (
    username: string,
    publicKey: string,
    signingPublicKey: string,
    opts?: { inviteToken?: string; bootstrapToken?: string }
  ) =>
    request<User>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username,
        publicKey,
        signingPublicKey,
        inviteToken: opts?.inviteToken,
        bootstrapToken: opts?.bootstrapToken,
      }),
    }),

  challenge: (username: string) =>
    request<{ nonce: string; expiresAt: number }>('/auth/challenge', {
      method: 'POST',
      body: JSON.stringify({ username }),
    }),

  verify: (username: string, signature: string) =>
    request<{ token: string; user: User }>('/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ username, signature }),
    }),

  attachSigning: (username: string, publicKey: string, signingPublicKey: string) =>
    request<{ status: string }>('/auth/attach-signing', {
      method: 'POST',
      body: JSON.stringify({ username, publicKey, signingPublicKey }),
    }),

  resetSigning: (username: string, publicKey: string, signingPublicKey: string) =>
    request<{ status: string }>('/auth/reset-signing', {
      method: 'POST',
      body: JSON.stringify({ username, publicKey, signingPublicKey }),
    }),

  deleteAccountByCredentials: (username: string, publicKey?: string) =>
    request<{ status: string }>('/auth/delete-account', {
      method: 'POST',
      body: JSON.stringify({ username, ...(publicKey ? { publicKey } : {}) }),
    }),

  deleteAccountByUsername: (username: string) =>
    request<{ status: string }>('/auth/delete-account', {
      method: 'POST',
      body: JSON.stringify({ username }),
    }),

  deleteAccount: () => request<{ status: string }>('/account', { method: 'DELETE' }),

  getMe: () => request<User>('/users/me'),

  uploadAvatar: async (file: Blob, mimeType = 'image/jpeg') => {
    const form = new FormData();
    form.append('file', file, 'avatar.jpg');
    form.append('mimeType', mimeType);
    return uploadAvatarWithAuth(form);
  },

  deleteAvatar: () =>
    request<{ status: string }>('/users/me/avatar', { method: 'DELETE' }),

  getAvatarBlob: (userId: string) =>
    fetchBlobWithAuth(`/users/${encodeURIComponent(userId)}/avatar`),

  getCircle: () => request<User[]>('/circle'),

  createInvite: (username: string) =>
    request<{ token: string }>('/invites', {
      method: 'POST',
      body: JSON.stringify({ username }),
    }),

  getAdminUsers: () => request<AdminUser[]>('/admin/users'),

  deleteAdminUser: (userId: string) =>
    request<{ status: string }>(`/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' }),

  searchUsers: (q = '') => request<User[]>(`/users?q=${encodeURIComponent(q)}`),

  createDirectChat: (otherUserId: string) =>
    request<{ id: string }>('/chats/direct', {
      method: 'POST',
      body: JSON.stringify({ otherUserId }),
    }),

  createGroup: (name: string, members: { userId: string; encryptedGroupKey: string }[]) =>
    request<{ id: string }>('/chats/group', {
      method: 'POST',
      body: JSON.stringify({ name, members }),
    }),

  deleteGroup: (chatId: string) =>
    request<{ status: string }>(`/chats/${chatId}`, { method: 'DELETE' }),

  deleteChat: (chatId: string) =>
    request<{ status: string }>(`/chats/${chatId}`, { method: 'DELETE' }),

  clearChat: (chatId: string) =>
    request<{ status: string }>(`/chats/${chatId}/messages`, { method: 'DELETE' }),

  addGroupMember: (
    chatId: string,
    userId: string,
    encryptedGroupKey: string,
    rekey?: { rekeyEpoch: number; memberKeys: { userId: string; encryptedGroupKey: string }[] }
  ) =>
    request<{ status: string }>(`/chats/${chatId}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId, encryptedGroupKey, ...rekey }),
    }),

  removeGroupMember: (
    chatId: string,
    userId: string,
    rekey?: { rekeyEpoch: number; memberKeys: { userId: string; encryptedGroupKey: string }[] }
  ) =>
    request<{ status: string }>(`/chats/${chatId}/members/${userId}`, {
      method: 'DELETE',
      body: rekey ? JSON.stringify(rekey) : undefined,
    }),

  distributeSystemGroupKeys: (
    chatId: string,
    members: { userId: string; encryptedGroupKey: string }[]
  ) =>
    request<{ status: string }>(`/chats/${chatId}/system-keys`, {
      method: 'POST',
      body: JSON.stringify({ members }),
    }),

  getChats: () => request<Chat[]>('/chats'),

  getMessages: (chatId: string, after = 0) =>
    request<RawMessage[]>(`/chats/${chatId}/messages?after=${after}`),

  deleteMessage: (chatId: string, messageId: string) =>
    request<{ status: string }>(
      `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
      { method: 'DELETE' },
    ),

  markChatRead: (chatId: string, lastReadAt: number) =>
    request<{ status: string }>(`/chats/${chatId}/read`, {
      method: 'POST',
      body: JSON.stringify({ lastReadAt }),
    }),

  sendMessage: (
    chatId: string,
    data: Omit<RawMessage, 'id' | 'chatId' | 'senderId' | 'createdAt'> & { pushBody?: string },
  ) =>
    request<RawMessage>(`/chats/${chatId}/messages`, { method: 'POST', body: JSON.stringify(data) }),

  uploadImage: async (chatId: string, file: Blob, iv: string, mimeType: string) => {
    const form = new FormData();
    form.append('file', file, 'image.enc');
    form.append('iv', iv);
    form.append('mimeType', mimeType);
    return uploadWithAuth(chatId, form);
  },

  getImage: (imageId: string) =>
    request<{ ciphertext: string; iv: string; mimeType: string }>(`/images/${imageId}`),

  unfurl: (url: string) =>
    request<{ url: string; title?: string; description?: string; image?: string; siteName?: string }>(
      `/unfurl?url=${encodeURIComponent(url)}`,
    ),

  getPushConfig: () =>
    request<{ enabled: boolean; publicKey: string }>('/push/vapid-public-key'),

  subscribePush: (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    request<{ status: string }>('/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(subscription),
    }),

  unsubscribePush: (endpoint: string) =>
    request<{ status: string }>('/push/subscribe', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint }),
    }),

  resetPushBadge: () =>
    request<{ status: string }>('/push/badge-reset', { method: 'POST' }),

  listChatLists: (chatId: string) =>
    request<RawChatList[]>(`/chats/${chatId}/lists`),

  createChatList: (chatId: string, titleCiphertext: string, titleIv: string) =>
    request<RawChatList>(`/chats/${chatId}/lists`, {
      method: 'POST',
      body: JSON.stringify({ titleCiphertext, titleIv }),
    }),

  deleteChatList: (chatId: string, listId: string) =>
    request<{ status: string }>(`/chats/${chatId}/lists/${listId}`, { method: 'DELETE' }),

  addChatListItem: (chatId: string, listId: string, textCiphertext: string, textIv: string) =>
    request<RawChatListItem>(`/chats/${chatId}/lists/${listId}/items`, {
      method: 'POST',
      body: JSON.stringify({ textCiphertext, textIv }),
    }),

  setChatListItemDone: (chatId: string, listId: string, itemId: string, done: boolean) =>
    request<RawChatListItem>(`/chats/${chatId}/lists/${listId}/items/${itemId}`, {
      method: 'PATCH',
      body: JSON.stringify({ done }),
    }),

  deleteChatListItem: (chatId: string, listId: string, itemId: string) =>
    request<{ status: string }>(`/chats/${chatId}/lists/${listId}/items/${itemId}`, {
      method: 'DELETE',
    }),
};

export interface RawChatListItem {
  id: string;
  listId: string;
  textCiphertext: string;
  textIv: string;
  done: boolean;
  position: number;
  createdByUserId?: string;
  updatedAt: number;
  updatedByUserId?: string;
}

export interface RawChatList {
  id: string;
  chatId: string;
  titleCiphertext: string;
  titleIv: string;
  createdByUserId?: string;
  createdAt: number;
  updatedAt: number;
  items: RawChatListItem[];
}
