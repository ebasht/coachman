/** Zoom / pan helpers for ImageLightbox (Telegram-style). */

export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
export const DOUBLE_TAP_SCALE = 2.5;
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_DIST_PX = 28;
export const WHEEL_ZOOM_FACTOR = 0.0015;

export type Point = { x: number; y: number };
export type Transform = { scale: number; tx: number; ty: number };

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Keep panned image within the viewport box at the current scale. */
export function clampPan(
  tx: number,
  ty: number,
  scale: number,
  width: number,
  height: number,
): Point {
  if (scale <= 1 + 1e-6) return { x: 0, y: 0 };
  const maxX = ((scale - 1) * width) / 2;
  const maxY = ((scale - 1) * height) / 2;
  return {
    x: Math.min(maxX, Math.max(-maxX, tx)),
    y: Math.min(maxY, Math.max(-maxY, ty)),
  };
}

/**
 * Zoom so the focal point (coords relative to the image/viewport center)
 * stays under the same screen position.
 */
export function zoomAround(
  current: Transform,
  nextScale: number,
  focalX: number,
  focalY: number,
  width: number,
  height: number,
): Transform {
  const scale = clampScale(nextScale);
  if (scale <= 1 + 1e-6) return { scale: 1, tx: 0, ty: 0 };
  const pointX = (focalX - current.tx) / current.scale;
  const pointY = (focalY - current.ty) / current.scale;
  const tx = focalX - pointX * scale;
  const ty = focalY - pointY * scale;
  const pan = clampPan(tx, ty, scale, width, height);
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
