import { afterEach, describe, expect, it, vi } from 'vitest';

describe('decryptMessage image path', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns a stub without downloading when photo is not cached', async () => {
    const loadImageBytes = vi.fn();
    vi.doMock('./image-download', () => ({ loadImageBytes }));
    vi.doMock('./storage', () => ({
      getCachedImage: vi.fn().mockResolvedValue(undefined),
      saveCachedImage: vi.fn(),
      loadGroupKeyArchive: vi.fn(),
      getMessages: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('./video-preview', () => ({
      resolveVideoPlaybackUrl: vi.fn(),
    }));
    vi.doMock('./image-preview', () => ({
      messageImageUrl: vi.fn(),
    }));
    vi.doMock('./transfer-progress', () => ({
      clearTransferProgress: vi.fn(),
      setTransferProgress: vi.fn(),
    }));

    const { decryptMessage } = await import('./messages');
    const result = await decryptMessage(
      {
        id: 'm1',
        chatId: 'c1',
        senderId: 'peer',
        ciphertext: '',
        iv: 'plain',
        type: 'image',
        imageId: 'img-1',
        createdAt: 1,
      },
      {
        id: 'c1',
        type: 'direct',
        name: '',
        members: [],
        createdAt: 1,
      } as never,
      'me',
      'priv',
      new Map(),
    );

    expect(result).toEqual({ text: '📷 Изображение' });
    expect(loadImageBytes).not.toHaveBeenCalled();
  });

  it('returns a video stub without resolving a stream URL', async () => {
    const resolveVideoPlaybackUrl = vi.fn();
    vi.doMock('./image-download', () => ({ loadImageBytes: vi.fn() }));
    vi.doMock('./storage', () => ({
      getCachedImage: vi.fn(),
      saveCachedImage: vi.fn(),
      loadGroupKeyArchive: vi.fn(),
      getMessages: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('./video-preview', () => ({ resolveVideoPlaybackUrl }));
    vi.doMock('./image-preview', () => ({ messageImageUrl: vi.fn() }));

    const { decryptMessage } = await import('./messages');
    const result = await decryptMessage(
      {
        id: 'v1',
        chatId: 'c1',
        senderId: 'peer',
        ciphertext: '',
        iv: 'plain',
        type: 'video',
        imageId: 'vid-1',
        createdAt: 1,
      },
      {
        id: 'c1',
        type: 'direct',
        name: '',
        members: [],
        createdAt: 1,
      } as never,
      'me',
      'priv',
      new Map(),
    );

    expect(result).toEqual({ text: '🎬 Видео' });
    expect(resolveVideoPlaybackUrl).not.toHaveBeenCalled();
  });
});

describe('media-hydrate queue', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('downloads missing photos in the background and reports patches newest-first', async () => {
    const order: string[] = [];
    const loadImageBytes = vi.fn(async (imageId: string) => {
      order.push(imageId);
      await new Promise((r) => setTimeout(r, 5));
      return {
        bytes: new Uint8Array([1, 2, 3]).buffer,
        mimeType: 'image/jpeg',
        iv: 'plain',
      };
    });

    vi.doMock('./image-download', () => ({ loadImageBytes }));
    vi.doMock('./storage', () => ({
      getCachedImage: vi.fn().mockResolvedValue(undefined),
      saveCachedImage: vi.fn().mockResolvedValue(undefined),
      loadGroupKeyArchive: vi.fn(),
    }));
    vi.doMock('./transfer-progress', () => ({
      setTransferProgress: vi.fn(),
      clearTransferProgress: vi.fn(),
    }));
    vi.doMock('./video-preview', () => ({
      resolveVideoPlaybackUrl: vi.fn(),
      resolveVideoPosterUrl: vi.fn(),
    }));
    vi.doMock('./crypto', () => ({
      decryptDirectBinary: vi.fn(),
      decryptBinary: vi.fn(),
      importPrivateKey: vi.fn(),
      importPublicKey: vi.fn(),
      importGroupKey: vi.fn(),
      isDirectEnvelopeV2: vi.fn(() => false),
    }));
    vi.doMock('./messages-encrypt', () => ({
      getChatEncryptionKey: vi.fn(),
      isPlainIv: (iv: string) => iv === 'plain',
    }));

    // jsdom may lack createObjectURL
    if (!URL.createObjectURL) {
      URL.createObjectURL = vi.fn(() => 'blob:mock') as typeof URL.createObjectURL;
    }

    const { scheduleMissingMediaHydration } = await import('./media-hydrate');
    const patches: string[] = [];
    const ctx = {
      chat: { id: 'c1', type: 'direct' as const, name: '', members: [], createdAt: 1 },
      myUserId: 'me',
      myPrivateKeyB64: 'priv',
    };

    scheduleMissingMediaHydration(
      [
        {
          id: 'old',
          chatId: 'c1',
          senderId: 'peer',
          senderName: 'P',
          text: '📷 Изображение',
          type: 'image',
          imageId: 'img-old',
          createdAt: 10,
        },
        {
          id: 'new',
          chatId: 'c1',
          senderId: 'peer',
          senderName: 'P',
          text: '📷 Изображение',
          type: 'image',
          imageId: 'img-new',
          createdAt: 20,
        },
        {
          id: 'text',
          chatId: 'c1',
          senderId: 'peer',
          senderName: 'P',
          text: 'hello',
          type: 'text',
          createdAt: 15,
        },
      ],
      ctx as never,
      (patch) => {
        patches.push(patch.id);
      },
    );

    await vi.waitFor(() => expect(patches).toHaveLength(2));
    // Newest scheduled first into the queue; workers pick it up first.
    expect(order[0]).toBe('img-new');
    expect(patches).toContain('new');
    expect(patches).toContain('old');
    expect(loadImageBytes).toHaveBeenCalledTimes(2);
  });
});
