import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type TouchEvent,
} from 'react';
import { notify } from '../lib/notify';
import { saveChatImage } from '../lib/save-image';
import {
  clampPan,
  DOUBLE_TAP_SCALE,
  isDoubleTap,
  touchDistance,
  touchMidpoint,
  WHEEL_ZOOM_FACTOR,
  zoomAround,
  type Transform,
} from '../lib/image-lightbox-zoom';

export interface LightboxImage {
  src: string;
  imageId?: string | null;
  messageId?: string | null;
}

interface Props {
  images: LightboxImage[];
  index: number;
  onClose: () => void;
}

const SWIPE_H_PX = 50;
const DISMISS_DY_PX = 120;
const DISMISS_VY = 0.65; // px/ms
const AXIS_LOCK_PX = 8;
const TAP_MOVE_PX = 12;

const IDENTITY: Transform = { scale: 1, tx: 0, ty: 0 };

export function ImageLightbox({ images, index, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const [current, setCurrent] = useState(index);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [transform, setTransform] = useState<Transform>(IDENTITY);
  const [animating, setAnimating] = useState(false);

  const transformRef = useRef(transform);
  transformRef.current = transform;

  const touchRef = useRef<{
    x: number;
    y: number;
    t: number;
    axis: 'h' | 'v' | 'pan' | null;
    moved: boolean;
  } | null>(null);

  const pinchRef = useRef<{
    startDist: number;
    start: Transform;
    startMidX: number;
    startMidY: number;
  } | null>(null);

  const lastTapRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const suppressClickRef = useRef(false);

  const count = images.length;
  const clampIndex = (i: number) => (count ? (i + count) % count : 0);
  const active = images[clampIndex(current)];
  const zoomed = transform.scale > 1.01;

  useEffect(() => {
    setCurrent(index);
  }, [index]);

  useEffect(() => {
    setTransform(IDENTITY);
    setDragY(0);
    setDragging(false);
    setAnimating(false);
    pinchRef.current = null;
    touchRef.current = null;
    lastTapRef.current = null;
  }, [current]);

  const viewportSize = () => {
    const el = rootRef.current;
    return { w: el?.clientWidth || window.innerWidth, h: el?.clientHeight || window.innerHeight };
  };

  const focalFromClient = (clientX: number, clientY: number) => {
    const el = rootRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return {
      x: clientX - rect.left - rect.width / 2,
      y: clientY - rect.top - rect.height / 2,
    };
  };

  const applyTransform = (next: Transform, animate = false) => {
    transformRef.current = next;
    setAnimating(animate);
    setTransform(next);
  };

  const toggleDoubleTapZoom = (clientX: number, clientY: number) => {
    const { w, h } = viewportSize();
    const cur = transformRef.current;
    const focal = focalFromClient(clientX, clientY);
    if (cur.scale > 1.01) {
      applyTransform(IDENTITY, true);
    } else {
      applyTransform(zoomAround(cur, DOUBLE_TAP_SCALE, focal.x, focal.y, w, h), true);
    }
  };

  const bumpZoom = (factor: number) => {
    const { w, h } = viewportSize();
    const cur = transformRef.current;
    applyTransform(zoomAround(cur, cur.scale * factor, 0, 0, w, h), true);
  };

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (transformRef.current.scale > 1.01) {
          applyTransform(IDENTITY, true);
          return;
        }
        onClose();
      } else if (e.key === 'ArrowLeft' && transformRef.current.scale <= 1.01) {
        setCurrent((c) => clampIndex(c - 1));
      } else if (e.key === 'ArrowRight' && transformRef.current.scale <= 1.01) {
        setCurrent((c) => clampIndex(c + 1));
      } else if (e.key === '+' || e.key === '=') {
        bumpZoom(1.25);
      } else if (e.key === '-' || e.key === '_') {
        bumpZoom(1 / 1.25);
      }
    };
    const onNativeWheel = (e: WheelEvent) => {
      e.preventDefault();
      const el = rootRef.current;
      if (!el) return;
      const { w, h } = { w: el.clientWidth, h: el.clientHeight };
      const rect = el.getBoundingClientRect();
      const focal = {
        x: e.clientX - rect.left - rect.width / 2,
        y: e.clientY - rect.top - rect.height / 2,
      };
      const cur = transformRef.current;
      const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_FACTOR);
      applyTransform(zoomAround(cur, cur.scale * factor, focal.x, focal.y, w, h), false);
      suppressClickRef.current = true;
    };
    window.addEventListener('keydown', onKey);
    const root = rootRef.current;
    root?.addEventListener('wheel', onNativeWheel, { passive: false });
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
      root?.removeEventListener('wheel', onNativeWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, count]);

  const onSave = async () => {
    if (saving || !active) return;
    setSaving(true);
    try {
      const result = await saveChatImage({
        src: active.src,
        imageId: active.imageId,
        messageId: active.messageId,
      });
      if (result === 'saved') notify.success('Фото сохранено');
    } catch {
      notify.error('Не удалось сохранить фото');
    } finally {
      setSaving(false);
    }
  };

  const goPrev = () => setCurrent((c) => clampIndex(c - 1));
  const goNext = () => setCurrent((c) => clampIndex(c + 1));
  const multiple = count > 1;

  const resetDrag = () => {
    touchRef.current = null;
    setDragging(false);
    setDragY(0);
  };

  const snapIfNearIdentity = () => {
    if (transformRef.current.scale < 1.05) {
      applyTransform(IDENTITY, true);
    }
  };

  const beginPinch = (e: TouchEvent) => {
    const a = e.touches[0];
    const b = e.touches[1];
    if (!a || !b) return;
    const mid = touchMidpoint(a, b);
    pinchRef.current = {
      startDist: Math.max(1, touchDistance(a, b)),
      start: { ...transformRef.current },
      startMidX: mid.x,
      startMidY: mid.y,
    };
    touchRef.current = null;
    setDragging(false);
    setDragY(0);
    setAnimating(false);
    suppressClickRef.current = true;
  };

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length >= 2) {
      beginPinch(e);
      return;
    }
    const t = e.touches[0];
    if (!t) return;
    pinchRef.current = null;
    touchRef.current = {
      x: t.clientX,
      y: t.clientY,
      t: Date.now(),
      axis: transformRef.current.scale > 1.01 ? 'pan' : null,
      moved: false,
    };
    setDragging(true);
    if (transformRef.current.scale > 1.01) setAnimating(false);
  };

  const onTouchMove = (e: TouchEvent) => {
    if (e.touches.length >= 2) {
      if (!pinchRef.current) beginPinch(e);
      const pinch = pinchRef.current;
      const a = e.touches[0];
      const b = e.touches[1];
      if (!pinch || !a || !b) return;
      const { w, h } = viewportSize();
      const dist = Math.max(1, touchDistance(a, b));
      const mid = touchMidpoint(a, b);
      const startFocal = focalFromClient(pinch.startMidX, pinch.startMidY);
      const nextScale = pinch.start.scale * (dist / pinch.startDist);
      // Zoom about the initial midpoint, then follow finger drift.
      const zoomedAtStart = zoomAround(
        pinch.start,
        nextScale,
        startFocal.x,
        startFocal.y,
        w,
        h,
      );
      const pan = clampPan(
        zoomedAtStart.tx + (mid.x - pinch.startMidX),
        zoomedAtStart.ty + (mid.y - pinch.startMidY),
        zoomedAtStart.scale,
        w,
        h,
      );
      applyTransform({ scale: zoomedAtStart.scale, tx: pan.x, ty: pan.y }, false);
      return;
    }

    const start = touchRef.current;
    const t = e.touches[0];
    if (!start || !t || pinchRef.current) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;

    if (Math.hypot(dx, dy) > TAP_MOVE_PX) {
      start.moved = true;
    }

    if (transformRef.current.scale > 1.01 || start.axis === 'pan') {
      start.axis = 'pan';
      const { w, h } = viewportSize();
      const cur = transformRef.current;
      const pan = clampPan(cur.tx + dx, cur.ty + dy, cur.scale, w, h);
      applyTransform({ scale: cur.scale, tx: pan.x, ty: pan.y }, false);
      start.x = t.clientX;
      start.y = t.clientY;
      return;
    }

    if (!start.axis) {
      if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
      start.axis = Math.abs(dy) > Math.abs(dx) ? 'v' : 'h';
    }

    if (start.axis === 'v') {
      // Only pull-down dismiss (Telegram-style); ignore upward.
      setDragY(Math.max(0, dy));
    }
  };

  const onTouchEnd = (e: TouchEvent) => {
    if (e.touches.length >= 2) {
      beginPinch(e);
      return;
    }

    if (e.touches.length === 1 && pinchRef.current) {
      pinchRef.current = null;
      snapIfNearIdentity();
      const t = e.touches[0];
      if (t && transformRef.current.scale > 1.01) {
        touchRef.current = {
          x: t.clientX,
          y: t.clientY,
          t: Date.now(),
          axis: 'pan',
          moved: true,
        };
        setDragging(true);
        setAnimating(false);
      } else {
        resetDrag();
      }
      return;
    }

    if (pinchRef.current) {
      pinchRef.current = null;
      snapIfNearIdentity();
      resetDrag();
      return;
    }

    const start = touchRef.current;
    if (!start) return;
    const t = e.changedTouches[0];
    const endX = t?.clientX ?? start.x;
    const endY = t?.clientY ?? start.y;
    const dx = endX - start.x;
    const dy = endY - start.y;
    const dt = Math.max(1, Date.now() - start.t);
    const axis = start.axis;

    if (axis === 'pan' || transformRef.current.scale > 1.01) {
      if (start.moved) suppressClickRef.current = true;
      resetDrag();
      return;
    }

    if (axis === 'v' || (!axis && dy > 40 && Math.abs(dy) > Math.abs(dx))) {
      const vy = dy / dt;
      if (dy > DISMISS_DY_PX || vy > DISMISS_VY) {
        onClose();
        return;
      }
      resetDrag();
      return;
    }

    if (multiple && (axis === 'h' || (!axis && Math.abs(dx) > SWIPE_H_PX))) {
      if (dx > SWIPE_H_PX) goPrev();
      else if (dx < -SWIPE_H_PX) goNext();
      resetDrag();
      return;
    }

    if (!start.moved && axis !== 'h' && axis !== 'v') {
      const tap = { x: endX, y: endY, t: Date.now() };
      if (isDoubleTap(lastTapRef.current, tap)) {
        lastTapRef.current = null;
        toggleDoubleTapZoom(endX, endY);
        suppressClickRef.current = true;
      } else {
        lastTapRef.current = tap;
      }
    }

    resetDrag();
  };

  const mousePanRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const onMouseDown = (e: ReactMouseEvent) => {
    if (e.button !== 0 || transformRef.current.scale <= 1.01) return;
    e.preventDefault();
    e.stopPropagation();
    mousePanRef.current = { x: e.clientX, y: e.clientY, moved: false };
    setDragging(true);
    setAnimating(false);
  };

  const onMouseMove = (e: ReactMouseEvent) => {
    const pan = mousePanRef.current;
    if (!pan) return;
    const dx = e.clientX - pan.x;
    const dy = e.clientY - pan.y;
    if (Math.hypot(dx, dy) > TAP_MOVE_PX) pan.moved = true;
    const { w, h } = viewportSize();
    const cur = transformRef.current;
    const next = clampPan(cur.tx + dx, cur.ty + dy, cur.scale, w, h);
    applyTransform({ scale: cur.scale, tx: next.x, ty: next.y }, false);
    pan.x = e.clientX;
    pan.y = e.clientY;
  };

  const endMousePan = () => {
    if (!mousePanRef.current) return;
    if (mousePanRef.current.moved) suppressClickRef.current = true;
    mousePanRef.current = null;
    setDragging(false);
  };

  const onDoubleClick = (e: ReactMouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    toggleDoubleTapZoom(e.clientX, e.clientY);
    suppressClickRef.current = true;
  };

  const onBackdropClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (zoomed) {
      applyTransform(IDENTITY, true);
      return;
    }
    onClose();
  };

  if (!active) return null;

  const dismissProgress = Math.min(1, dragY / 280);
  const backdropAlpha = 0.92 * (1 - dismissProgress * 0.75);
  const dismissScale = 1 - dismissProgress * 0.08;
  const scale = transform.scale * (dragY ? dismissScale : 1);
  const tx = transform.tx;
  const ty = transform.ty + dragY;

  return (
    <div
      ref={rootRef}
      className={`image-lightbox${dragging && (dragY > 0 || zoomed) ? ' is-dragging' : ''}${zoomed ? ' is-zoomed' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Просмотр фото"
      style={{ background: `rgba(0, 0, 0, ${backdropAlpha})` }}
      onClick={onBackdropClick}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={() => {
        pinchRef.current = null;
        resetDrag();
      }}
      onMouseMove={onMouseMove}
      onMouseUp={endMousePan}
      onMouseLeave={endMousePan}
    >
      <img
        key={active.src}
        className="image-lightbox-img"
        src={active.src}
        alt=""
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={onDoubleClick}
        onMouseDown={onMouseDown}
        draggable={false}
        style={{
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          opacity: 1 - dismissProgress * 0.35,
          transition:
            dragging || !animating ? 'none' : 'transform 0.2s ease, opacity 0.2s ease',
          cursor: zoomed ? 'grab' : 'zoom-in',
        }}
        onTransitionEnd={() => setAnimating(false)}
      />

      <div
        className="image-lightbox-toolbar"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="image-lightbox-icon-btn"
          disabled={saving}
          onClick={() => void onSave()}
          aria-label={saving ? 'Сохранение…' : 'Сохранить'}
        >
          {saving ? (
            <span className="image-lightbox-spinner" aria-hidden />
          ) : (
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
              <path
                fill="currentColor"
                d="M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6 .67 2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2z"
              />
            </svg>
          )}
        </button>
        {multiple && (
          <span className="image-lightbox-counter" aria-live="polite">
            {clampIndex(current) + 1} / {count}
          </span>
        )}
        <button
          type="button"
          className="image-lightbox-icon-btn"
          onClick={onClose}
          aria-label="Закрыть"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
            <path
              fill="currentColor"
              d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
            />
          </svg>
        </button>
      </div>

      {multiple && !zoomed && (
        <button
          type="button"
          className="image-lightbox-nav prev"
          aria-label="Предыдущее фото"
          onClick={(e) => {
            e.stopPropagation();
            goPrev();
          }}
          onTouchStart={(e) => e.stopPropagation()}
        >
          <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden>
            <path fill="currentColor" d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z" />
          </svg>
        </button>
      )}

      {multiple && !zoomed && (
        <button
          type="button"
          className="image-lightbox-nav next"
          aria-label="Следующее фото"
          onClick={(e) => {
            e.stopPropagation();
            goNext();
          }}
          onTouchStart={(e) => e.stopPropagation()}
        >
          <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden>
            <path fill="currentColor" d="m8.6 7.4 1.4-1.4 6 6-6 6-1.4-1.4L13.2 12z" />
          </svg>
        </button>
      )}
    </div>
  );
}
