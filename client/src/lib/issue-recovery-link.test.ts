import { describe, expect, it, vi } from 'vitest';
import {
  createSerialQueue,
  issueRecoveryLink,
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
    });
    expect(result?.token).toBe('tok-ok');
    expect(result?.link).toContain('recover=tok-ok');
    expect(result?.link).toContain('k=');
  });
});

describe('createSerialQueue + StrictMode-like double issue', () => {
  it('only the latest non-stale issue keeps its token in the store mock', async () => {
    const store = new Map<string, string>();
    const enqueue = createSerialQueue();
    let gen = 0;

    const runIssue = async () => {
      const myGen = ++gen;
      const isStale = () => myGen !== gen;
      return enqueue(async () => {
        if (isStale()) return null;
        // Simulate server: replace previous recovery for user.
        const createLoginRecovery = async (_userId: string, ciphertext: string) => {
          await new Promise((r) => setTimeout(r, 5));
          const token = `t-${ciphertext.slice(0, 8)}-${Math.random().toString(36).slice(2, 6)}`;
          store.set('u1', token);
          return { token, expiresAt: Date.now() + 60_000 };
        };
        return issueRecoveryLink({
          userId: 'u1',
          bundle,
          createLoginRecovery,
          isStale,
          origin: 'http://localhost:5173',
        });
      });
    };

    // Overlap like React Strict Mode: start A, then B before A finishes.
    const pA = runIssue();
    const pB = runIssue();
    const [a, b] = await Promise.all([pA, pB]);

    expect(a).toBeNull();
    expect(b).not.toBeNull();
    expect(store.get('u1')).toBe(b!.token);
  });
});
