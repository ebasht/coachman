const API = '/api';

let authToken: string | null = null;

export function setAuthToken(token: string | null) {
  authToken = token;
}

export function getAuthToken() {
  return authToken;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string>),
  };
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const res = await fetch(`${API}${path}`, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error: string }).error || 'Request failed');
  }
  return res.json();
}

export interface User {
  id: string;
  username: string;
  publicKey: string;
  isAdmin?: boolean;
}

export interface InviteInfo {
  token: string;
  inviterUsername: string;
  expiresAt?: number;
}

export interface InviteGraphNode {
  id: string;
  username: string;
  isAdmin: boolean;
}

export interface InviteGraphEdge {
  from: string;
  to: string;
}

export interface InviteGraph {
  nodes: InviteGraphNode[];
  edges: InviteGraphEdge[];
}

export interface ChatMember {
  id: string;
  username: string;
  publicKey: string;
  encryptedGroupKey?: string;
}

export interface Chat {
  id: string;
  type: 'direct' | 'group';
  name: string | null;
  displayName: string;
  createdByUserId?: string;
  groupKeyEpoch?: number;
  members: ChatMember[];
  lastMessage: { id: string; senderId: string; type: string; createdAt: number } | null;
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

  getCircle: () => request<User[]>('/circle'),

  createInvite: () => request<{ token: string }>('/invites', { method: 'POST' }),

  getInviteGraph: () => request<InviteGraph>('/admin/invite-graph'),

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

  getChats: () => request<Chat[]>('/chats'),

  getMessages: (chatId: string, after = 0) =>
    request<RawMessage[]>(`/chats/${chatId}/messages?after=${after}`),

  sendMessage: (chatId: string, data: Omit<RawMessage, 'id' | 'chatId' | 'senderId' | 'createdAt'>) =>
    request<RawMessage>(`/chats/${chatId}/messages`, { method: 'POST', body: JSON.stringify(data) }),

  uploadImage: async (chatId: string, file: Blob, iv: string, mimeType: string) => {
    const form = new FormData();
    form.append('file', file, 'image.enc');
    form.append('iv', iv);
    form.append('mimeType', mimeType);
    const headers: Record<string, string> = {};
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const res = await fetch(`${API}/chats/${chatId}/images`, { method: 'POST', body: form, headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const raw = ((err as { error?: string }).error || res.statusText || '').toLowerCase();
      if (res.status === 413 || raw.includes('entity too large') || raw.includes('too large')) {
        throw new Error('Фото слишком большое для загрузки. Попробуйте другое или сделайте снимок с меньшим разрешением.');
      }
      throw new Error((err as { error: string }).error || 'Не удалось загрузить фото');
    }
    return res.json() as Promise<{ id: string }>;
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
};
