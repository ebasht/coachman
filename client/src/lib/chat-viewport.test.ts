import { describe, expect, it } from 'vitest';
import {
  BOTTOM_THRESHOLD_PX,
  measureChatViewport,
} from './chat-viewport';

function fakeScroller(partial: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): HTMLElement {
  return partial as HTMLElement;
}

describe('BOTTOM_THRESHOLD_PX', () => {
  it('stays in the agreed sticky-bottom band', () => {
    expect(BOTTOM_THRESHOLD_PX).toBeGreaterThanOrEqual(24);
    expect(BOTTOM_THRESHOLD_PX).toBeLessThanOrEqual(64);
  });
});

describe('measureChatViewport', () => {
  it('reports flush bottom', () => {
    const m = measureChatViewport(
      fakeScroller({ scrollHeight: 1000, scrollTop: 700, clientHeight: 300 }),
    );
    expect(m.distanceToBottom).toBe(0);
    expect(m.isAtBottom).toBe(true);
    expect(m.hasMessagesBelow).toBe(false);
  });

  it('isAtBottom within threshold while hasMessagesBelow stays true', () => {
    const m = measureChatViewport(
      fakeScroller({
        scrollHeight: 1000,
        scrollTop: 1000 - 300 - BOTTOM_THRESHOLD_PX,
        clientHeight: 300,
      }),
    );
    expect(m.distanceToBottom).toBe(BOTTOM_THRESHOLD_PX);
    expect(m.isAtBottom).toBe(true);
    expect(m.hasMessagesBelow).toBe(true);
  });

  it('leaves the bottom past the threshold', () => {
    const m = measureChatViewport(
      fakeScroller({
        scrollHeight: 1000,
        scrollTop: 1000 - 300 - (BOTTOM_THRESHOLD_PX + 1),
        clientHeight: 300,
      }),
    );
    expect(m.distanceToBottom).toBe(BOTTOM_THRESHOLD_PX + 1);
    expect(m.isAtBottom).toBe(false);
    expect(m.hasMessagesBelow).toBe(true);
  });

  it('clamps negative distance from overscroll', () => {
    const m = measureChatViewport(
      fakeScroller({ scrollHeight: 500, scrollTop: 250, clientHeight: 300 }),
    );
    expect(m.distanceToBottom).toBe(0);
    expect(m.isAtBottom).toBe(true);
    expect(m.hasMessagesBelow).toBe(false);
  });
});
