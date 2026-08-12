import { describe, expect, it } from 'vitest';
import {
  clampPan,
  clampScale,
  isDoubleTap,
  MAX_SCALE,
  MIN_SCALE,
  touchDistance,
  touchMidpoint,
  zoomAround,
} from './image-lightbox-zoom';

describe('image-lightbox-zoom', () => {
  it('clamps scale to [MIN, MAX]', () => {
    expect(clampScale(0.2)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(2)).toBe(2);
  });

  it('resets pan at scale 1', () => {
    expect(clampPan(40, -20, 1, 400, 800)).toEqual({ x: 0, y: 0 });
  });

  it('limits pan to half of overscan', () => {
    // scale 2 on 400×800 → max ±200 × ±400
    expect(clampPan(999, -999, 2, 400, 800)).toEqual({ x: 200, y: -400 });
    expect(clampPan(10, 20, 2, 400, 800)).toEqual({ x: 10, y: 20 });
  });

  it('zoomAround keeps focal point stable and snaps to 1', () => {
    const base = { scale: 1, tx: 0, ty: 0 };
    const z = zoomAround(base, 2, 100, 50, 400, 800);
    expect(z.scale).toBe(2);
    // focal was at (100,50); after zoomAround from identity: tx = 100 - 100*2 = -100
    expect(z.tx).toBe(-100);
    expect(z.ty).toBe(-50);

    expect(zoomAround(z, 0.5, 0, 0, 400, 800)).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  it('touch helpers', () => {
    expect(touchDistance({ clientX: 0, clientY: 0 }, { clientX: 3, clientY: 4 })).toBe(5);
    expect(touchMidpoint({ clientX: 0, clientY: 0 }, { clientX: 10, clientY: 20 })).toEqual({
      x: 5,
      y: 10,
    });
  });

  it('detects double tap within time and distance', () => {
    const a = { x: 10, y: 10, t: 1000 };
    expect(isDoubleTap(a, { x: 12, y: 11, t: 1200 })).toBe(true);
    expect(isDoubleTap(a, { x: 12, y: 11, t: 1400 })).toBe(false);
    expect(isDoubleTap(a, { x: 80, y: 10, t: 1100 })).toBe(false);
    expect(isDoubleTap(null, a)).toBe(false);
  });
});
