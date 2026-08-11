// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  findMessageById,
  findReplyTargetElement,
} from './message-reply';
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

describe('findMessageById', () => {
  it('matches exact id only', () => {
    const list = [msg({ id: 'a', createdAt: 10 }), msg({ id: 'b', createdAt: 20 })];
    expect(findMessageById(list, 'b')?.id).toBe('b');
    expect(findMessageById(list, 'missing')).toBeUndefined();
  });
});

describe('findReplyTargetElement', () => {
  it('returns the wrap for a direct message id', () => {
    document.body.innerHTML = `
      <div class="messages">
        <div data-message-id="m1" class="message-wrap"></div>
        <div data-message-id="m2" class="message-wrap"></div>
      </div>
    `;
    const root = document.querySelector('.messages')!;
    const el = findReplyTargetElement(root, 'm2', [
      msg({ id: 'm1' }),
      msg({ id: 'm2' }),
    ]);
    expect(el?.getAttribute('data-message-id')).toBe('m2');
  });

  it('resolves absorbed album members to the first tile wrap', () => {
    document.body.innerHTML = `
      <div class="messages">
        <div data-message-id="a1" class="message-wrap"></div>
      </div>
    `;
    const root = document.querySelector('.messages')!;
    const messages = [
      msg({ id: 'a1', type: 'image', albumId: 'alb', createdAt: 1 }),
      msg({ id: 'a2', type: 'image', albumId: 'alb', createdAt: 2 }),
      msg({ id: 'a3', type: 'image', albumId: 'alb', createdAt: 3 }),
    ];
    const el = findReplyTargetElement(root, 'a3', messages);
    expect(el?.getAttribute('data-message-id')).toBe('a1');
  });

  it('returns null when the id is absent (no timestamp fallback)', () => {
    document.body.innerHTML = `
      <div class="messages">
        <div data-message-id="m1" class="message-wrap"></div>
      </div>
    `;
    const root = document.querySelector('.messages')!;
    expect(findReplyTargetElement(root, 'gone', [msg({ id: 'm1' })])).toBeNull();
  });
});
