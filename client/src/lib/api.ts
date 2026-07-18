const API = '/api';
const REQUEST_TIMEOUT_MS = 25_000;
/** Mobile image uploads often exceed 20s; never use the short “offline probe” timeout here. */
const UPLOAD_TIMEOUT_MS = 90_000;

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
  timeoutMs = REQUEST_TIMEOUT_MS,
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

export type UploadProgressFn = (percent: number) => void;

function xhrSend(opts: {
  method: string;
  url: string;
  body?: Blob | FormData | null;
  headers?: Record<string, string>;
  timeoutMs: number;
  onUploadProgress?: UploadProgressFn;
}): Promise<{ status: number; responseText: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(opts.method, opts.url);
    xhr.timeout = opts.timeoutMs;
    if (opts.headers) {
      for (const [k, v] of Object.entries(opts.headers)) {
        // Let the browser set multipart boundary for FormData.
        if (k.toLowerCase() === 'content-type' && opts.body instanceof FormData) continue;
        xhr.setRequestHeader(k, v);
      }
    }
    if (opts.onUploadProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) {
          opts.onUploadProgress!(Math.round((e.loaded / e.total) * 100));
        }
      };
    }
    xhr.onload = () => resolve({ status: xhr.status, responseText: xhr.responseText });
    xhr.onerror = () => reject(new Error('network error'));
    xhr.ontimeout = () => reject(new Error('Превышено время ожидания ответа сервера'));
    xhr.send(opts.body ?? null);
  });
}

/** Download with progress (CDN / same-origin). */
export function fetchArrayBufferWithProgress(
  url: string,
  onProgress?: UploadProgressFn,
  timeoutMs = UPLOAD_TIMEOUT_MS,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.timeout = timeoutMs;
    xhr.onprogress = (e) => {
      if (onProgress && e.lengthComputable && e.total > 0) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`HTTP ${xhr.status}`));
        return;
      }
      onProgress?.(100);
      resolve(xhr.response as ArrayBuffer);
    };
    xhr.onerror = () => reject(new Error('network error'));
    xhr.ontimeout = () => reject(new Error('Превышено время ожидания ответа сервера'));
    xhr.send();
  });
}

async function putToCdn(uploadUrl: string, file: Blob, onProgress?: UploadProgressFn): Promise<void> {
  // Do not set Content-Type — it is not part of the simple presigned signature.
  onProgress?.(0);
  const { status, responseText } = await xhrSend({
    method: 'PUT',
    url: uploadUrl,
    body: file,
    timeoutMs: UPLOAD_TIMEOUT_MS,
    onUploadProgress: onProgress,
  });
  if (status < 200 || status >= 300) {
    const hint = responseText?.slice(0, 180) || '';
    console.warn('CDN PUT failed', status, hint);
    throw new Error(`Не удалось загрузить фото на CDN (${status})`);
  }
  onProgress?.(100);
}

async function completeImageUpload(
  chatId: string,
  data: { id: string; iv: string; mimeType: string; size: number },
  retried = false,
): Promise<{ id: string }> {
  await ensureAuthToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const res = await fetchWithTimeout(
    `${API}/chats/${chatId}/images/complete`,
    { method: 'POST', headers, body: JSON.stringify(data) },
    REQUEST_TIMEOUT_MS,
  );

  if (res.status === 401 && !retried && authRefresher && !refreshingAuth) {
    refreshingAuth = true;
    try {
      const ok = await authRefresher();
      if (ok) return completeImageUpload(chatId, data, true);
    } finally {
      refreshingAuth = false;
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error: string }).error || 'Не удалось подтвердить загрузку фото');
  }
  return res.json() as Promise<{ id: string }>;
}

async function uploadImageDirect(
  chatId: string,
  file: Blob,
  iv: string,
  mimeType: string,
  onProgress?: UploadProgressFn,
  retried = false,
): Promise<{ id: string } | null> {
  await ensureAuthToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  // 1) Ask API for a presigned CDN URL (no DB write yet).
  const res = await fetchWithTimeout(
    `${API}/chats/${chatId}/images/upload-url`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ iv, mimeType, size: file.size }),
    },
    REQUEST_TIMEOUT_MS,
  );

  if (res.status === 401 && !retried && authRefresher && !refreshingAuth) {
    refreshingAuth = true;
    try {
      const ok = await authRefresher();
      if (ok) return uploadImageDirect(chatId, file, iv, mimeType, onProgress, true);
    } finally {
      refreshingAuth = false;
    }
  }

  if (res.status === 503) return null; // S3 not configured — fall back to API multipart
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const raw = ((err as { error?: string }).error || res.statusText || '').toLowerCase();
    if (res.status === 413 || raw.includes('too large')) {
      throw new Error('Фото слишком большое для загрузки (макс. 25 МБ).');
    }
    throw new Error((err as { error: string }).error || 'Не удалось подготовить загрузку фото');
  }

  const prep = (await res.json()) as { id: string; uploadUrl: string };
  if (!prep.id || !prep.uploadUrl) {
    throw new Error('Не удалось подготовить загрузку фото');
  }

  // 2) Upload bytes straight to CDN.
  await putToCdn(prep.uploadUrl, file, onProgress);

  // 3) Register metadata on the server only after CDN PUT succeeded.
  return completeImageUpload(chatId, {
    id: prep.id,
    iv,
    mimeType,
    size: file.size,
  });
}

async function uploadWithAuth(
  chatId: string,
  buildForm: () => FormData,
  onProgress?: UploadProgressFn,
  retried = false,
): Promise<{ id: string }> {
  await ensureAuthToken();
  const headers: Record<string, string> = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  onProgress?.(0);
  const { status, responseText } = await xhrSend({
    method: 'POST',
    url: `${API}/chats/${chatId}/images`,
    body: buildForm(),
    headers,
    timeoutMs: UPLOAD_TIMEOUT_MS,
    onUploadProgress: onProgress,
  });

  if (status === 401 && !retried && authRefresher && !refreshingAuth) {
    refreshingAuth = true;
    try {
      const ok = await authRefresher();
      if (ok) return uploadWithAuth(chatId, buildForm, onProgress, true);
    } finally {
      refreshingAuth = false;
    }
  }

  if (status < 200 || status >= 300) {
    let errMsg = 'Не удалось загрузить фото';
    try {
      const err = JSON.parse(responseText) as { error?: string };
      if (err.error) errMsg = err.error;
    } catch {
      /* ignore */
    }
    const raw = errMsg.toLowerCase();
    if (status === 413 || raw.includes('entity too large') || raw.includes('too large')) {
      throw new Error('Фото слишком большое для загрузки. Попробуйте другое или сделайте снимок с меньшим разрешением.');
    }
    throw new Error(errMsg);
  }
  onProgress?.(100);
  return JSON.parse(responseText) as { id: string };
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
  type: 'text' | 'image' | 'call' | 'list';
  imageId?: string;
  clientId?: string;
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

  /** Promote current user to admin with the server BOOTSTRAP_TOKEN (demotes previous admin). */
  claimAdmin: (bootstrapToken: string) =>
    request<User>('/users/me/claim-admin', {
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

  /** Paginate through the whole chat (server returns max 100 per request). */
  async getAllMessages(chatId: string, after = 0): Promise<RawMessage[]> {
    const all: RawMessage[] = [];
    let cursor = after;
    for (;;) {
      const batch = await request<RawMessage[]>(`/chats/${chatId}/messages?after=${cursor}`);
      if (!batch.length) break;
      all.push(...batch);
      const nextCursor = batch[batch.length - 1]!.createdAt;
      if (nextCursor <= cursor) break;
      cursor = nextCursor;
      if (batch.length < 100) break;
    }
    return all;
  },

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
    data: Omit<RawMessage, 'id' | 'chatId' | 'senderId' | 'createdAt'> & {
      clientId?: string;
      /** "alert" shows a push; "badge" only bumps icon badge / chat unread. */
      notify?: 'alert' | 'badge';
    },
  ) =>
    request<RawMessage>(`/chats/${chatId}/messages`, { method: 'POST', body: JSON.stringify(data) }),

  getIceServers: () => request<{ iceServers: RTCIceServer[] }>('/ice-servers'),

  uploadImage: async (
    chatId: string,
    file: Blob,
    iv: string,
    mimeType: string,
    onProgress?: UploadProgressFn,
  ) => {
    // Prefer direct CDN PUT (presigned) so large photos bypass the API/nginx body limit.
    const direct = await uploadImageDirect(chatId, file, iv, mimeType, onProgress);
    if (direct) return direct;

    const buildForm = () => {
      const form = new FormData();
      form.append('file', file, 'image.enc');
      form.append('iv', iv);
      form.append('mimeType', mimeType);
      return form;
    };
    return uploadWithAuth(chatId, buildForm, onProgress);
  },

  getImage: (imageId: string) =>
    request<{ ciphertext?: string; url?: string; iv: string; mimeType: string }>(`/images/${imageId}`),

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

  registerDevicePushToken: (body: { token: string; platform: 'android' | 'ios' }) =>
    request<{ status: string }>('/push/device-token', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  unregisterDevicePushToken: (token: string) =>
    request<{ status: string }>('/push/device-token', {
      method: 'DELETE',
      body: JSON.stringify({ token }),
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
