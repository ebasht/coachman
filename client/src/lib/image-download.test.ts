import { describe, expect, it, vi, afterEach } from 'vitest';

describe('loadImageBytes CDN fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('uses /api/images/:id/bytes when presigned CDN GET fails', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const getImage = vi.fn().mockResolvedValue({
      url: 'https://storage.example/bucket/photo.jpg?sig=1',
      iv: 'plain',
      mimeType: 'image/jpeg',
    });
    const fetchImageBytes = vi.fn().mockResolvedValue(payload.buffer);

    vi.doMock('./transfer-progress', () => ({
      setTransferProgress: vi.fn(),
      clearTransferProgress: vi.fn(),
    }));
    vi.doMock('./api', () => ({
      api: { getImage, fetchImageBytes },
      fetchArrayBufferWithProgress: vi.fn().mockRejectedValue(new Error('network error')),
      base64ToArrayBuffer: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer,
    }));

    const { loadImageBytes } = await import('./image-download');
    const result = await loadImageBytes('img-1', 'prog-1');
    expect(result.mimeType).toBe('image/jpeg');
    expect(new Uint8Array(result.bytes)).toEqual(payload);
    expect(fetchImageBytes).toHaveBeenCalledWith('img-1', expect.any(Function));
  });
});
