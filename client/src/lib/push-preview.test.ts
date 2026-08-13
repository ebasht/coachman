import { describe, expect, it } from 'vitest';
import { truncatePushBody } from './push-preview';

describe('truncatePushBody', () => {
  it('normalizes whitespace', () => {
    expect(truncatePushBody('  hello   world  ')).toBe('hello world');
  });

  it('returns empty for blank input', () => {
    expect(truncatePushBody('')).toBe('');
    expect(truncatePushBody('   ')).toBe('');
    expect(truncatePushBody(null)).toBe('');
    expect(truncatePushBody(undefined)).toBe('');
  });

  it('keeps short text intact', () => {
    expect(truncatePushBody('Привет')).toBe('Привет');
  });

  it('truncates long unicode text with ellipsis', () => {
    const long = 'あ'.repeat(130);
    const got = truncatePushBody(long);
    const chars = Array.from(got);
    expect(chars).toHaveLength(120);
    expect(chars.at(-1)).toBe('…');
    expect(chars.slice(0, 119).join('')).toBe('あ'.repeat(119));
  });
});
