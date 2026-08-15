import { describe, expect, it, vi } from 'vitest';
import {
  createSerialQueue,
  issueRecoveryLink,
  issueRecoveryLinkLatest,
} from './issue-recovery-link';
import type { RecoveryKeyBundle } from './login-recovery';

const bundle: RecoveryKeyBundle = {
  v: 1,
  privateKey: 'priv',
  signingPrivateKey: 'sign-priv',
  signingPublicKey: 'sign-pub',
};

describe('issueRecoveryLink stale guard', () => {
  it('skips create when already stale after wrap', async () => {
    const createLoginRecovery = vi.fn(async () => ({
      token: 'tok',
      expiresAt: Date.now() + 60_000,
    }));
    const result = await issueRecoveryLink({
      userId: 'u1',
      bundle,
      createLoginRecovery,
      isStale: () => true,
      origin: 'http://localhost:5173',
      serialize: false,
    });
    expect(result).toBeNull();
    expect(createLoginRecovery).not.toHaveBeenCalled();
  });

  it('returns null when stale after create (does not expose revoked token)', async () => {
    let stale = false;
    const createLoginRecovery = vi.fn(async () => {
      stale = true;
      return { token: 'tok-stale', expiresAt: Date.now() + 60_000 };
    });
    const result = await issueRecoveryLink({
      userId: 'u1',
      bundle,
      createLoginRecovery,
      isStale: () => stale,
      origin: 'http://localhost:5173',
      serialize: false,
    });
    expect(createLoginRecovery).toHaveBeenCalledOnce();
    expect(result).toBeNull();
  });

  it('returns link when not stale', async () => {
    const createLoginRecovery = vi.fn(async () => ({
      token: 'tok-ok',
      expiresAt: 123,
    }));
    const result = await issueRecoveryLink({
      userId: 'u1',
      bundle,
      createLoginRecovery,
      isStale: () => false,
      origin: 'http://localhost:5173',
      serialize: false,
    });
    expect(result?.token).toBe('tok-ok');
    expect(result?.link).toContain('recover=tok-ok');
    expect(result?.link).toContain('k=');
  });
});

describe('issueRecoveryLinkLatest + overlapping calls', () => {
  it('only the latest issue keeps its token in the store mock', async () => {
    const store = new Map<string, string>();
    let n = 0;
    const createLoginRecovery = async (_userId: string, _ciphertext: string) => {
      await new Promise((r) => setTimeout(r, 15));
      const token = `t-${++n}-${Math.random().toString(36).slice(2, 6)}`;
      store.set('u1', token);
      return { token, expiresAt: Date.now() + 60_000 };
    };

    const pA = issueRecoveryLinkLatest({
      userId: 'u1',
      bundle,
      createLoginRecovery,
      origin: 'http://localhost:5173',
    });
    const pB = issueRecoveryLinkLatest({
      userId: 'u1',
      bundle,
      createLoginRecovery,
      origin: 'http://localhost:5173',
    });
    const [a, b] = await Promise.all([pA, pB]);

    expect(a).toBeNull();
    expect(b).not.toBeNull();
    expect(store.get('u1')).toBe(b!.token);
  });
});

describe('createSerialQueue', () => {
  it('runs tasks in order', async () => {
    const enqueue = createSerialQueue();
    const order: number[] = [];
    await Promise.all([
      enqueue(async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(1);
      }),
      enqueue(async () => {
        order.push(2);
      }),
    ]);
    expect(order).toEqual([1, 2]);
  });
});
