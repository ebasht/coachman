// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  localStorage.clear();
});

describe('cold-start auth persistence', () => {
  it('waits for a slow iOS IndexedDB token instead of treating it as logout', async () => {
    vi.useFakeTimers();
    const getKey = vi.fn(
      () => new Promise<string>((resolve) => window.setTimeout(() => resolve('jwt-slow'), 3_500)),
    );
    vi.doMock('./storage', () => ({
      getKey,
      saveKey: vi.fn(),
      deleteKey: vi.fn(),
    }));

    const { loadSessionTokenReliable } = await import('./auth-persistence');
    const pending = loadSessionTokenReliable('user-1');
    await vi.advanceTimersByTimeAsync(3_500);

    await expect(pending).resolves.toBe('jwt-slow');
    expect(localStorage.getItem('cm:token:user-1')).toBe('jwt-slow');
  });
});
