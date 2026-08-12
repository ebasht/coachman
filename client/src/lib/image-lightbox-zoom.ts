/** Zoom / pan helpers for ImageLightbox (Telegram / WhatsApp style). */

export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
/** Double-tap target — close to Telegram’s ~2.5–3×. */
export const DOUBLE_TAP_SCALE = 2.75;
export const DOUBLE_TAP_MS = 280;
export const DOUBLE_TAP_DIST_PX = 32;
export const WHEEL_ZOOM_FACTOR = 0.0015;
/** Soft resistance when pinching past min/max or panning past edges. */
export const RUBBER = 0.4;
export const SETTLE_MS = 220;
export const INERTIA_FRICTION = 0.92;
export const INERTIA_MIN_V = 0.04; // px/ms

export type Point = { x: number; y: number };
export type Transform = { scale: number; tx: number; ty: number };

export const IDENTITY: Transform = { scale: 1, tx: 0, ty: 0 };

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Soft clamp for live pinch: allow overshoot past [min,max] with resistance.
 * Settled with clampScale() on gesture end.
 */
export function rubberScale(scale: number, min = MIN_SCALE, max = MAX_SCALE): number {
  if (scale < min) return min - (min - scale) * RUBBER;
  if (scale > max) return max + (scale - max) * RUBBER;
  return scale;
}

/** Max pan offsets so the scaled image still covers the viewport (or centers if smaller). */
export function panLimits(
  scale: number,
  imgW: number,
  imgH: number,
  viewW: number,
  viewH: number,
): Point {
  if (scale <= 1 + 1e-6) return { x: 0, y: 0 };
  return {
    x: Math.max(0, (imgW * scale - viewW) / 2),
    y: Math.max(0, (imgH * scale - viewH) / 2),
  };
}

export function clampPan(
  tx: number,
  ty: number,
  scale: number,
  imgW: number,
  imgH: number,
  viewW: number,
  viewH: number,
): Point {
  if (scale <= 1 + 1e-6) return { x: 0, y: 0 };
  const lim = panLimits(scale, imgW, imgH, viewW, viewH);
  return {
    // `|| 0` normalizes -0 from Math.max(-0, …)
    x: Math.min(lim.x, Math.max(-lim.x, tx)) || 0,
    y: Math.min(lim.y, Math.max(-lim.y, ty)) || 0,
  };
}

/** Live pan with rubber-band past edges (snaps back on settle). */
export function rubberPan(
  tx: number,
  ty: number,
  scale: number,
  imgW: number,
  imgH: number,
  viewW: number,
  viewH: number,
): Point {
  const lim = panLimits(scale, imgW, imgH, viewW, viewH);
  const soft = (v: number, max: number) => {
    if (max <= 0) return v * RUBBER * 0.5;
    if (v > max) return max + (v - max) * RUBBER;
    if (v < -max) return -max + (v + max) * RUBBER;
    return v;
  };
  return { x: soft(tx, lim.x), y: soft(ty, lim.y) };
}

/**
 * Zoom so the focal point (coords relative to the viewport center)
 * stays under the same screen position.
 */
export function zoomAround(
  current: Transform,
  nextScale: number,
  focalX: number,
  focalY: number,
  imgW: number,
  imgH: number,
  viewW: number,
  viewH: number,
  soft = false,
): Transform {
  const scale = soft ? rubberScale(nextScale) : clampScale(nextScale);
  if (scale <= 1 + 1e-6 && !soft) return { ...IDENTITY };
  if (scale <= 1 + 1e-6 && soft && nextScale <= 1) {
    // Keep a little undershoot visual while pinching in.
    const s = rubberScale(nextScale);
    return { scale: s, tx: 0, ty: 0 };
  }
  const pointX = (focalX - current.tx) / current.scale;
  const pointY = (focalY - current.ty) / current.scale;
  const tx = focalX - pointX * scale;
  const ty = focalY - pointY * scale;
  const pan = soft
    ? rubberPan(tx, ty, Math.max(scale, 1), imgW, imgH, viewW, viewH)
    : clampPan(tx, ty, scale, imgW, imgH, viewW, viewH);
  return { scale, tx: pan.x, ty: pan.y };
}

/** Snap live transform into hard bounds after pinch/pan. */
export function settleTransform(
  current: Transform,
  imgW: number,
  imgH: number,
  viewW: number,
  viewH: number,
): Transform {
  const scale = clampScale(current.scale);
  if (scale <= 1 + 1e-6) return { ...IDENTITY };
  const pan = clampPan(current.tx, current.ty, scale, imgW, imgH, viewW, viewH);
  return { scale, tx: pan.x, ty: pan.y };
}

export function touchDistance(
  a: { clientX: number; clientY: number },
  b: { clientX: number; clientY: number },
): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

export function touchMidpoint(
  a: { clientX: number; clientY: number },
  b: { clientX: number; clientY: number },
): Point {
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

export function isDoubleTap(
  prev: { x: number; y: number; t: number } | null,
  next: { x: number; y: number; t: number },
): boolean {
  if (!prev) return false;
  if (next.t - prev.t > DOUBLE_TAP_MS) return false;
  return Math.hypot(next.x - prev.x, next.y - prev.y) <= DOUBLE_TAP_DIST_PX;
}
