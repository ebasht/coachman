import { describe, expect, it } from 'vitest';
import { looksLikeLegacyPlaintext } from './ciphertext-display';

describe('looksLikeLegacyPlaintext', () => {
  it('rejects short base64 ciphertext that used to be shown as «битые» messages', () => {
    expect(looksLikeLegacyPlaintext('U7QwWBW0023KLLVCxLLUVn2ugLMaLgJo')).toBe(false);
    expect(looksLikeLegacyPlaintext('dGACOVgsOZYOcRH5Y6q+dDc=')).toBe(false);
  });

  it('accepts obvious plaintext without plain iv', () => {
    expect(looksLikeLegacyPlaintext('Привет')).toBe(true);
    expect(looksLikeLegacyPlaintext('hello world')).toBe(true);
  });

  it('rejects empty', () => {
    expect(looksLikeLegacyPlaintext('')).toBe(false);
    expect(looksLikeLegacyPlaintext('   ')).toBe(false);
  });
});
