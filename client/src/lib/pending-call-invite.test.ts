// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rows = new Map<string, Response>();
const cache = {
  put: vi.fn(async (key: string, value: Response) => {
    rows.set(key, value);
  }),
  match: vi.fn(async (key: string) => rows.get(key)),
  delete: vi.fn(async (key: string) => rows.delete(key)),
};

vi.stubGlobal('caches', {
  open: vi.fn(async () => cache),
});

const {
  DISMISSED_CALL_URL_PREFIX,
  PENDING_CALL_URL,
  isCallDismissedAsync,
  loadPendingCallInviteAsync,
  markCallDismissed,
} = await import('./pending-call-invite');

beforeEach(() => {
  rows.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
});

describe('ended call tombstones', () => {
  it('survives a new PWA session and blocks a stale call URL', async () => {
    markCallDismissed('call-ended-1');
    await vi.waitFor(() =>
      expect(rows.has(`${DISMISSED_CALL_URL_PREFIX}call-ended-1`)).toBe(true),
    );
    sessionStorage.clear();

    await expect(isCallDismissedAsync('call-ended-1')).resolves.toBe(true);
  });

  it('does not restore a cached invite after the call ended', async () => {
    rows.set(
      PENDING_CALL_URL,
      new Response(JSON.stringify({
        chatId: 'chat-1',
        callId: 'call-ended-2',
        savedAt: Date.now(),
      })),
    );
    rows.set(
      `${DISMISSED_CALL_URL_PREFIX}call-ended-2`,
      new Response(String(Date.now())),
    );

    await expect(loadPendingCallInviteAsync()).resolves.toBeNull();
  });
});
