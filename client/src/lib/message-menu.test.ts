import { describe, expect, it } from 'vitest';
import { placeMessageMenu } from './message-menu';

describe('placeMessageMenu', () => {
  const viewport = { top: 0, bottom: 800, left: 0, right: 360 };
  const menu = { width: 140, height: 100 };

  it('prefers below when there is room', () => {
    const r = placeMessageMenu({
      anchor: { top: 200, bottom: 260, left: 20, right: 180 },
      viewport,
      menu,
    });
    expect(r.placement).toBe('below');
    expect(r.fullyVisible).toBe(true);
  });

  it('flips above near the bottom edge', () => {
    const r = placeMessageMenu({
      anchor: { top: 720, bottom: 780, left: 20, right: 180 },
      viewport,
      menu,
    });
    expect(r.placement).toBe('above');
    expect(r.fullyVisible).toBe(true);
  });
});
