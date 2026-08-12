import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  confirmBootstrapRebind,
  hasLocalBootstrapKeys,
  pickBootstrapLocalAccount,
} from './bootstrap-local';
import type { LocalAccount } from './storage';

function account(partial: Partial<LocalAccount> & Pick<LocalAccount, 'userId' | 'username' | 'publicKey'>): LocalAccount {
  return { ...partial };
}

describe('pickBootstrapLocalAccount', () => {
  it('prefers isAdmin when several accounts exist', () => {
    const admin = account({
      userId: 'a1',
      username: 'Светлана',
      publicKey: 'pk',
      isAdmin: true,
      privateKey: 'priv',
    });
    const other = account({
      userId: 'u2',
      username: 'Игорь',
      publicKey: 'pk2',
      privateKey: 'priv2',
    });
    expect(pickBootstrapLocalAccount([other, admin])).toBe(admin);
  });

  it('uses the only local account even without isAdmin (legacy)', () => {
    const sole = account({
      userId: 'a1',
      username: 'Ямщик',
      publicKey: 'pk',
      privateKey: 'priv',
    });
    expect(pickBootstrapLocalAccount([sole])).toBe(sole);
  });

  it('returns null when multiple non-admin accounts need a manual choice', () => {
    const a = account({ userId: '1', username: 'a', publicKey: 'p', privateKey: 'x' });
    const b = account({ userId: '2', username: 'b', publicKey: 'p', privateKey: 'y' });
    expect(pickBootstrapLocalAccount([a, b])).toBeNull();
  });
});

describe('hasLocalBootstrapKeys', () => {
  it('detects unwrapped and passphrase-wrapped keys', () => {
    expect(
      hasLocalBootstrapKeys(
        account({ userId: '1', username: 'a', publicKey: 'p', privateKey: 'x' }),
      ),
    ).toBe(true);
    expect(
      hasLocalBootstrapKeys(
        account({
          userId: '1',
          username: 'a',
          publicKey: 'p',
          encryptedPrivateKey: { salt: 's', iv: 'i', ciphertext: 'c' },
        }),
      ),
    ).toBe(true);
    expect(hasLocalBootstrapKeys(account({ userId: '1', username: 'a', publicKey: 'p' }))).toBe(
      false,
    );
    expect(hasLocalBootstrapKeys(null)).toBe(false);
  });
});

describe('confirmBootstrapRebind', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks for confirmation and returns the result', () => {
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirm);
    expect(confirmBootstrapRebind(true)).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    expect(String(confirm.mock.calls[0]?.[0])).toMatch(/новые ключи/i);
    expect(String(confirm.mock.calls[0]?.[0])).toMatch(/сохранённый аккаунт/i);
  });
});
