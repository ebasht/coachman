import { describe, expect, it } from 'vitest';
import {
  clampPan,
  clampScale,
  IDENTITY,
  isDoubleTap,
  MAX_SCALE,
  MIN_SCALE,
  panLimits,
  rubberPan,
  rubberScale,
  settleTransform,
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

  it('rubberScale softens overshoot', () => {
    expect(rubberScale(0.5)).toBeLessThan(1);
    expect(rubberScale(0.5)).toBeGreaterThan(0.5);
    expect(rubberScale(MAX_SCALE + 1)).toBeGreaterThan(MAX_SCALE);
    expect(rubberScale(MAX_SCALE + 1)).toBeLessThan(MAX_SCALE + 1);
    expect(rubberScale(2)).toBe(2);
  });

  it('panLimits use content size, not full viewport fill', () => {
    // Letterboxed: 200×400 image in 400×800 view — no pan until scale > 2
    expect(panLimits(1, 200, 400, 400, 800)).toEqual({ x: 0, y: 0 });
    expect(panLimits(2, 200, 400, 400, 800)).toEqual({ x: 0, y: 0 });
    expect(panLimits(3, 200, 400, 400, 800)).toEqual({ x: 100, y: 200 });
  });

  it('clampPan zeros at scale 1 and limits overflow', () => {
    const z = clampPan(40, -20, 1, 400, 800, 400, 800);
    expect(z.x).toBe(0);
    expect(z.y).toBe(0);
    // Full-bleed 400×800 at scale 2 → max ±200 × ±400
    expect(clampPan(999, -999, 2, 400, 800, 400, 800)).toEqual({ x: 200, y: -400 });
  });

  it('rubberPan allows soft overscroll', () => {
    const hard = clampPan(300, 0, 2, 400, 800, 400, 800);
    const soft = rubberPan(300, 0, 2, 400, 800, 400, 800);
    expect(hard.x).toBe(200);
    expect(soft.x).toBeGreaterThan(200);
    expect(soft.x).toBeLessThan(300);
  });

  it('zoomAround keeps focal point stable and snaps to identity', () => {
    const z = zoomAround(IDENTITY, 2, 100, 50, 400, 800, 400, 800);
    expect(z.scale).toBe(2);
    expect(z.tx).toBe(-100);
    expect(z.ty).toBe(-50);
    expect(zoomAround(z, 0.5, 0, 0, 400, 800, 400, 800)).toEqual(IDENTITY);
  });

  it('settleTransform hard-clamps after soft pinch', () => {
    expect(settleTransform({ scale: 0.7, tx: 10, ty: 10 }, 400, 800, 400, 800)).toEqual(
      IDENTITY,
    );
    const settled = settleTransform({ scale: 5, tx: 999, ty: 0 }, 400, 800, 400, 800);
    expect(settled.scale).toBe(MAX_SCALE);
    expect(Math.abs(settled.tx)).toBeLessThanOrEqual(
      panLimits(MAX_SCALE, 400, 800, 400, 800).x + 1e-6,
    );
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
