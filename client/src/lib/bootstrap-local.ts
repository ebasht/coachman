import type { LocalAccount } from './storage';

/**
 * Pick a local account to sign in with when opening a bootstrap link.
 * Prefer marked admin; if exactly one account exists (legacy rows without isAdmin), use it.
 * Returns null when the user must choose / rebind — never invent an admin among many.
 */
export function pickBootstrapLocalAccount(
  accounts: LocalAccount[],
): LocalAccount | null {
  const admin = accounts.find((a) => a.isAdmin);
  if (admin) return admin;
  if (accounts.length === 1) return accounts[0] ?? null;
  return null;
}

/** True when this device already has keys we must not overwrite via rebind. */
export function hasLocalBootstrapKeys(account: LocalAccount | null | undefined): boolean {
  return !!(account?.privateKey || account?.encryptedPrivateKey);
}

/**
 * Confirm destructive admin key rotation. Returns false if the user cancels.
 */
export function confirmBootstrapRebind(hasLocalAccounts: boolean): boolean {
  const localHint = hasLocalAccounts
    ? 'На этом устройстве уже есть сохранённый аккаунт — лучше войти в него без смены ключей.\n\n'
    : '';
  return globalThis.confirm(
    `${localHint}` +
      'Привязка устройства создаёт новые ключи шифрования.\n\n' +
      'Старые сообщения (текст) на этом аккаунте станет невозможно прочитать. Фото обычно остаются.\n\n' +
      'Продолжить только если это другое устройство или ключи на этом уже потеряны?',
  );
}
