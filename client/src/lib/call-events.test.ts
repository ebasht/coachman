import { beforeEach, describe, expect, it, vi } from 'vitest';

const getMessages = vi.fn();
const saveMessage = vi.fn();
const enqueueCallOutbox = vi.fn();
const flushOutbox = vi.fn();
const outboxClientId = vi.fn((id: string) => id.replace(/^pending-/, ''));

vi.mock('./storage', () => ({
  getMessages: (...args: unknown[]) => getMessages(...args),
  saveMessage: (...args: unknown[]) => saveMessage(...args),
}));

vi.mock('./outbox', () => ({
  enqueueCallOutbox: (...args: unknown[]) => enqueueCallOutbox(...args),
  flushOutbox: (...args: unknown[]) => flushOutbox(...args),
  outboxClientId: (id: string) => outboxClientId(id),
}));

vi.mock('./messages-encrypt', () => ({
  encryptChatMessage: vi.fn(async (text: string) => ({ ciphertext: text, iv: 'plain' })),
}));

const { postCallEventMessage } = await import('./call-events');

beforeEach(() => {
  vi.clearAllMocks();
  getMessages.mockImplementation(async () => {
    await Promise.resolve();
    return [];
  });
  saveMessage.mockResolvedValue(undefined);
  enqueueCallOutbox.mockResolvedValue(undefined);
  flushOutbox.mockResolvedValue(0);
});

describe('postCallEventMessage', () => {
  it('coalesces concurrent terminal callbacks for the same callId', async () => {
    const opts = {
      event: { chatId: 'chat-1', callId: 'call-race-1', kind: 'ended' as const, durationSec: 3 },
      chat: {
        id: 'chat-1',
        type: 'direct' as const,
        name: '',
        displayName: 'Peer',
        members: [],
        lastMessage: null,
        createdAt: 1,
      },
      userId: 'me',
      username: 'Я',
      privateKeyB64: 'private',
    };

    await Promise.all([postCallEventMessage(opts), postCallEventMessage(opts)]);

    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(enqueueCallOutbox).toHaveBeenCalledTimes(1);
    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'pending-call-call-race-1',
        clientId: 'call-call-race-1',
      }),
    );
  });
});
