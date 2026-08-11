import { describe, expect, it } from 'vitest';
import {
  messageClientKey,
  messageServerId,
  mergeMessageEntity,
  sameMessageIdentity,
} from './message-identity';
import type { StoredMessage } from './storage';

function msg(partial: Partial<StoredMessage> & Pick<StoredMessage, 'id'>): StoredMessage {
  return {
    chatId: 'c1',
    senderId: 'u1',
    senderName: 'A',
    text: 'hi',
    type: 'text',
    createdAt: 1,
    ...partial,
  };
}

describe('messageServerId', () => {
  it('returns confirmed server ids', () => {
    expect(messageServerId(msg({ id: 'srv-1' }))).toBe('srv-1');
    expect(messageServerId(msg({ id: 'srv-1', pending: false }))).toBe('srv-1');
  });

  it('ignores pending / pending-* temp ids', () => {
    expect(messageServerId(msg({ id: 'pending-cid', pending: true }))).toBeUndefined();
    expect(messageServerId(msg({ id: 'pending-cid' }))).toBeUndefined();
    expect(messageServerId(msg({ id: 'srv-1', pending: true }))).toBeUndefined();
  });
});

describe('messageClientKey', () => {
  it('prefers explicit clientId', () => {
    expect(messageClientKey({ id: 'srv-1', clientId: 'cid' })).toBe('cid');
    expect(messageClientKey({ id: 'pending-other', clientId: 'cid' })).toBe('cid');
  });

  it('derives clientId from pending-* id', () => {
    expect(messageClientKey({ id: 'pending-cid' })).toBe('cid');
  });

  it('returns undefined for bare server ids without clientId', () => {
    expect(messageClientKey({ id: 'srv-1' })).toBeUndefined();
  });
});

describe('sameMessageIdentity', () => {
  it('matches same server ID', () => {
    expect(
      sameMessageIdentity(
        { id: 'srv-1', clientId: 'a' },
        { id: 'srv-1', clientId: 'b' },
      ),
    ).toBe(true);
  });

  it('matches same clientId', () => {
    expect(
      sameMessageIdentity(
        { id: 'srv-1', clientId: 'cid' },
        { id: 'srv-2', clientId: 'cid' },
      ),
    ).toBe(true);
  });

  it('matches pending ID + clientId', () => {
    expect(
      sameMessageIdentity({ id: 'pending-cid' }, { id: 'srv-1', clientId: 'cid' }),
    ).toBe(true);
    expect(
      sameMessageIdentity(
        { id: 'pending-cid', clientId: 'cid', pending: true } as StoredMessage,
        { id: 'srv-1', clientId: 'cid' },
      ),
    ).toBe(true);
  });

  it('does not match different IDs with the same text', () => {
    const a = msg({ id: 'srv-1', clientId: 'a', text: 'Да', sequence: 1 });
    const b = msg({ id: 'srv-2', clientId: 'b', text: 'Да', sequence: 2 });
    expect(sameMessageIdentity(a, b)).toBe(false);
    expect(sameMessageIdentity({ id: 'srv-1' }, { id: 'srv-2' })).toBe(false);
  });
});

describe('mergeMessageEntity', () => {
  it('merges pending → server, keeping clientId and hydrated media', () => {
    const pending = msg({
      id: 'pending-cid',
      clientId: 'cid',
      pending: true,
      text: 'hello',
      createdAt: 10,
      imageUrl: 'blob:local',
      posterUrl: 'blob:poster',
      failed: true,
      error: 'timeout',
    });
    const server = msg({
      id: 'srv-1',
      clientId: 'cid',
      pending: false,
      text: 'hello',
      createdAt: 11,
      sequence: 4,
    });

    const merged = mergeMessageEntity(pending, server);
    expect(merged.id).toBe('srv-1');
    expect(merged.clientId).toBe('cid');
    expect(merged.pending).toBe(false);
    expect(merged.failed).toBe(false);
    expect(merged.error).toBeUndefined();
    expect(merged.sequence).toBe(4);
    expect(merged.createdAt).toBe(11);
    expect(merged.imageUrl).toBe('blob:local');
    expect(merged.posterUrl).toBe('blob:poster');
    expect(merged.text).toBe('hello');
  });

  it('keeps local text when server echo has empty text', () => {
    const pending = msg({
      id: 'pending-cid',
      clientId: 'cid',
      pending: true,
      text: 'local body',
      createdAt: 10,
    });
    const server = msg({
      id: 'srv-1',
      clientId: 'cid',
      text: '',
      createdAt: 11,
      sequence: 1,
    });
    expect(mergeMessageEntity(pending, server).text).toBe('local body');
  });

  it('prefers higher sequence among confirmed rows', () => {
    const older = msg({ id: 'srv-1', clientId: 'cid', sequence: 1, createdAt: 10, text: 'a' });
    const newer = msg({ id: 'srv-1', clientId: 'cid', sequence: 2, createdAt: 9, text: 'b' });
    expect(mergeMessageEntity(older, newer).text).toBe('b');
    expect(mergeMessageEntity(older, newer).sequence).toBe(2);
  });

  it('preserves reply metadata from the optimistic side', () => {
    const pending = msg({
      id: 'pending-cid',
      clientId: 'cid',
      pending: true,
      replyToMessageId: 'parent',
      replyToPreview: 'quote',
      replyToType: 'text',
      albumId: 'alb-1',
    });
    const server = msg({
      id: 'srv-1',
      clientId: 'cid',
      createdAt: 11,
      sequence: 3,
    });
    const merged = mergeMessageEntity(pending, server);
    expect(merged.replyToMessageId).toBe('parent');
    expect(merged.replyToPreview).toBe('quote');
    expect(merged.albumId).toBe('alb-1');
  });
});
