import { describe, expect, it } from 'vitest';
import { isPlainMediaIv, looksLikeMediaBytes } from './media-bytes';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe('looksLikeMediaBytes', () => {
  it('accepts JPEG / PNG / GIF / WEBP / MP4 / WebM magic', () => {
    expect(looksLikeMediaBytes(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0))).toBe(true);
    expect(looksLikeMediaBytes(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0))).toBe(
      true,
    );
    expect(looksLikeMediaBytes(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0))).toBe(true);
    expect(
      looksLikeMediaBytes(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)),
    ).toBe(true);
    expect(
      looksLikeMediaBytes(bytes(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d)),
    ).toBe(true);
    expect(looksLikeMediaBytes(bytes(0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0))).toBe(true);
  });

  it('rejects AES-looking or tiny payloads', () => {
    expect(looksLikeMediaBytes(bytes(0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc))).toBe(
      false,
    );
    expect(looksLikeMediaBytes(bytes(0xff, 0xd8))).toBe(false);
    expect(looksLikeMediaBytes(new ArrayBuffer(0))).toBe(false);
  });
});

describe('isPlainMediaIv', () => {
  it('treats empty and plain markers as unencrypted', () => {
    expect(isPlainMediaIv('plain')).toBe(true);
    expect(isPlainMediaIv('plain-v1')).toBe(true);
    expect(isPlainMediaIv('')).toBe(true);
    expect(isPlainMediaIv(undefined)).toBe(true);
    expect(isPlainMediaIv('aes-gcm')).toBe(false);
  });
});
