import { describe, expect, it } from 'vitest';
import {
  lockGestureAxis,
  resolveGestureAction,
  shouldCancelLongPress,
} from './chat-gesture';

describe('chat-gesture', () => {
  it('locks vertical vs horizontal with bias', () => {
    expect(lockGestureAxis({ dx: 0, dy: 0 })).toBe(null);
    expect(lockGestureAxis({ dx: 30, dy: 5 })).toBe('h');
    expect(lockGestureAxis({ dx: 5, dy: 30 })).toBe('v');
  });

  it('resolves mutually exclusive actions', () => {
    expect(resolveGestureAction({ axis: 'v', dx: 0, longPressFired: false })).toBe('scroll');
    expect(resolveGestureAction({ axis: 'h', dx: 48, longPressFired: false })).toBe('reply');
    expect(resolveGestureAction({ axis: null, dx: 0, longPressFired: true })).toBe('menu');
  });

  it('cancels long-press after movement', () => {
    expect(shouldCancelLongPress(0, 0)).toBe(false);
    expect(shouldCancelLongPress(10, 0)).toBe(true);
  });
});
