import { describe, expect, it } from 'vitest';
import { isMediaMessageType, prioritizeTextMessages } from './message-priority';

describe('prioritizeTextMessages', () => {
  it('moves photos after text so a mixed batch paints plaintext first', () => {
    const rows = [
      { id: 'p1', type: 'image' },
      { id: 't1', type: 'text' },
      { id: 'p2', type: 'video' },
      { id: 't2', type: 'list' },
    ];
    expect(prioritizeTextMessages(rows).map((r) => r.id)).toEqual(['t1', 't2', 'p1', 'p2']);
  });

  it('leaves an already-ordered list unchanged', () => {
    const rows = [{ type: 'text' }, { type: 'image' }];
    expect(prioritizeTextMessages(rows)).toEqual(rows);
  });
});

describe('isMediaMessageType', () => {
  it('detects image and video only', () => {
    expect(isMediaMessageType('image')).toBe(true);
    expect(isMediaMessageType('video')).toBe(true);
    expect(isMediaMessageType('text')).toBe(false);
  });
});
