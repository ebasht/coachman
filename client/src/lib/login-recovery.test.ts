import { describe, expect, it } from 'vitest';
import { parseAuthLink } from './invite-link';
import {
  parseRecoveryParams,
  wrapRecoveryBundle,
  unwrapRecoveryBundle,
  encryptKeyBackupForAdmin,
  decryptKeyBackupAsAdmin,
  type RecoveryKeyBundle,
} from './login-recovery';
import { generateKeyPair, exportPublicKey } from './crypto';

describe('parseAuthLink recovery', () => {
  it('parses recover + k from URL', () => {
    const link = parseAuthLink('https://example.com/?recover=tok123&k=key456');
    expect(link).toEqual({ type: 'recover', token: 'tok123', key: 'key456' });
  });

  it('parses recover from fragment-like text', () => {
    const link = parseAuthLink('open ?recover=abc&k=def more');
    expect(link).toEqual({ type: 'recover', token: 'abc', key: 'def' });
  });

  it('still parses invite', () => {
    expect(parseAuthLink('https://x/?invite=inv')).toEqual({ type: 'invite', token: 'inv' });
  });
});

describe('parseRecoveryParams', () => {
  it('requires both token and key', () => {
    expect(parseRecoveryParams('https://x/?recover=only')).toBeNull();
    expect(parseRecoveryParams('https://x/?recover=a&k=b')).toEqual({ token: 'a', key: 'b' });
  });
});

describe('recovery crypto', () => {
  const bundle: RecoveryKeyBundle = {
    v: 1,
    privateKey: 'priv-b64',
    signingPrivateKey: 'sign-priv-b64',
    signingPublicKey: 'sign-pub-b64',
  };

  it('wraps and unwraps with link key', async () => {
    const wrapped = await wrapRecoveryBundle(bundle);
    expect(wrapped.keyB64Url.length).toBeGreaterThan(20);
    const out = await unwrapRecoveryBundle(wrapped.ciphertext, wrapped.keyB64Url);
    expect(out).toEqual(bundle);
  });

  it('escrows to admin public key', async () => {
    const admin = await generateKeyPair();
    const adminPub = await exportPublicKey(admin.publicKey);
    const envelope = await encryptKeyBackupForAdmin(bundle, adminPub);
    const out = await decryptKeyBackupAsAdmin(envelope, admin.privateKey, adminPub);
    expect(out).toEqual(bundle);
  });
});
