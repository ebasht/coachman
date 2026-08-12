import { describe, expect, it, vi, beforeEach } from 'vitest';

const loadGroupKey = vi.fn();
const loadGroupKeyEpoch = vi.fn();
const saveGroupKeyWithEpoch = vi.fn();
const loadGroupKeyArchive = vi.fn();

vi.mock('./storage', () => ({
  loadGroupKey: (...args: unknown[]) => loadGroupKey(...args),
  loadGroupKeyEpoch: (...args: unknown[]) => loadGroupKeyEpoch(...args),
  saveGroupKeyWithEpoch: (...args: unknown[]) => saveGroupKeyWithEpoch(...args),
  loadGroupKeyArchive: (...args: unknown[]) => loadGroupKeyArchive(...args),
  getLocalAccountByUserId: vi.fn(async () => null),
}));

vi.mock('./api', () => ({
  api: {
    getChats: vi.fn(async () => []),
    distributeSystemGroupKeys: vi.fn(),
    distributeGroupKeyWraps: vi.fn(),
  },
}));

vi.mock('./system-group', () => ({
  syncSystemGroupKeys: vi.fn(async () => false),
}));

vi.mock('./admin-key-backup', () => ({
  hydrateGroupKeysFromBackup: vi.fn(async () => false),
  loadRememberedBootstrapToken: vi.fn(async () => undefined),
  tryUploadAdminKeyBackup: vi.fn(async () => {}),
}));

vi.mock('./group-wrap-repair', () => ({
  repairGroupWrapsIfNeeded: vi.fn(async (chat: unknown) => chat),
}));

vi.mock('./crypto', async () => {
  const actual = await vi.importActual<typeof import('./crypto')>('./crypto');
  return {
    ...actual,
    importPrivateKey: vi.fn(async () => ({}) as CryptoKey),
    importGroupKey: vi.fn(async (raw: string) => ({ raw }) as unknown as CryptoKey),
  };
});

import { getChatEncryptionKey } from './messages-encrypt';
import type { Chat } from './api';

function groupChat(overrides?: Partial<Chat>): Chat {
  return {
    id: 'g1',
    type: 'group',
    isSystem: true,
    groupKeyEpoch: 3,
    members: [
      { id: 'admin', username: 'Админ', publicKey: 'pk' },
      { id: 'u2', username: 'Игорь', publicKey: 'pk2', encryptedGroupKey: 'wrap' },
    ],
    ...overrides,
  } as Chat;
}

describe('getChatEncryptionKey after bootstrap wrap loss', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadGroupKeyArchive.mockResolvedValue({});
    saveGroupKeyWithEpoch.mockResolvedValue(undefined);
  });

  it('uses local/backup cache when own wrap is missing', async () => {
    loadGroupKey.mockResolvedValue('cached-group-key');
    loadGroupKeyEpoch.mockResolvedValue(3);
    const key = await getChatEncryptionKey(groupChat(), 'admin', 'priv');
    expect(key).toEqual({ raw: 'cached-group-key' });
  });

  it('uses cache even when epoch was cleared after logout', async () => {
    loadGroupKey.mockResolvedValue('cached-group-key');
    loadGroupKeyEpoch.mockResolvedValue(undefined);
    const key = await getChatEncryptionKey(groupChat(), 'admin', 'priv');
    expect(key).toEqual({ raw: 'cached-group-key' });
    expect(saveGroupKeyWithEpoch).toHaveBeenCalled();
  });
});
