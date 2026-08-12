import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./api', () => ({
  api: {
    putAdminKeyBackup: vi.fn(async () => ({ status: 'ok' })),
    fetchAdminKeyBackup: vi.fn(),
  },
}));

vi.mock('./storage', async () => {
  const mem = new Map<string, string>();
  return {
    saveKey: async (id: string, value: string) => {
      mem.set(id, value);
    },
    getKey: async (id: string) => mem.get(id),
    deleteKey: async (id: string) => {
      mem.delete(id);
    },
    exportGroupKeyMaterial: async () => ({
      chat1: { current: 'gk', epoch: 1, archive: { '1': 'gk' } },
    }),
    importGroupKeyMaterial: vi.fn(async () => {}),
  };
});

import { api } from './api';
import { importGroupKeyMaterial } from './storage';
import {
  uploadAdminKeyBackup,
  restoreAdminFromBackup,
  hydrateGroupKeysFromBackup,
} from './admin-key-backup';
import type { LocalAccount } from './storage';

describe('admin-key-backup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uploads encrypted backup and restores the same identity keys', async () => {
    const account: LocalAccount = {
      userId: 'u1',
      username: 'Админ',
      publicKey: 'pub',
      privateKey: 'priv-secret',
      signingPublicKey: 'spub',
      signingPrivateKey: 'spriv',
      isAdmin: true,
    };

    let stored: {
      salt: string;
      iv: string;
      ciphertext: string;
      userId: string;
    } | null = null;
    vi.mocked(api.putAdminKeyBackup).mockImplementation(async (body) => {
      stored = {
        salt: body.salt,
        iv: body.iv,
        ciphertext: body.ciphertext,
        userId: body.userId,
      };
      return { status: 'ok' };
    });
    vi.mocked(api.fetchAdminKeyBackup).mockImplementation(async () => {
      if (!stored) throw new Error('missing');
      return {
        userId: stored.userId,
        salt: stored.salt,
        iv: stored.iv,
        ciphertext: stored.ciphertext,
        version: 1,
        updatedAt: 1,
      };
    });

    await uploadAdminKeyBackup(account, 'bootstrap-secret-token');
    expect(api.putAdminKeyBackup).toHaveBeenCalledOnce();
    const uploaded = vi.mocked(api.putAdminKeyBackup).mock.calls[0]?.[0];
    expect(uploaded?.ciphertext).toBeTruthy();
    expect(uploaded?.ciphertext).not.toContain('priv-secret');
    expect(stored).not.toBeNull();

    const restored = await restoreAdminFromBackup('bootstrap-secret-token');
    expect(restored).toMatchObject({
      userId: 'u1',
      username: 'Админ',
      publicKey: 'pub',
      privateKey: 'priv-secret',
      signingPrivateKey: 'spriv',
      isAdmin: true,
    });
    expect(importGroupKeyMaterial).toHaveBeenCalled();
  });

  it('hydrates group keys from backup for the matching user', async () => {
    const account: LocalAccount = {
      userId: 'u1',
      username: 'Админ',
      publicKey: 'pub',
      privateKey: 'priv',
      isAdmin: true,
    };
    let stored: {
      salt: string;
      iv: string;
      ciphertext: string;
      userId: string;
    } | null = null;
    vi.mocked(api.putAdminKeyBackup).mockImplementation(async (body) => {
      stored = {
        salt: body.salt,
        iv: body.iv,
        ciphertext: body.ciphertext,
        userId: body.userId,
      };
      return { status: 'ok' };
    });
    vi.mocked(api.fetchAdminKeyBackup).mockImplementation(async () => ({
      userId: stored!.userId,
      salt: stored!.salt,
      iv: stored!.iv,
      ciphertext: stored!.ciphertext,
      version: 1,
      updatedAt: 1,
    }));

    await uploadAdminKeyBackup(account, 'tok');
    vi.mocked(importGroupKeyMaterial).mockClear();
    const ok = await hydrateGroupKeysFromBackup('tok', 'u1');
    expect(ok).toBe(true);
    expect(importGroupKeyMaterial).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ chat1: expect.anything() }),
    );
  });
});
