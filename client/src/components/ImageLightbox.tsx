import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { notify } from '../lib/notify';
import { saveChatImage } from '../lib/save-image';
import {
  DOUBLE_TAP_SCALE,
  IDENTITY,
  INERTIA_FRICTION,
  INERTIA_MIN_V,
  isDoubleTap,
  rubberPan,
  settleTransform,
  SETTLE_MS,
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
const TAP_MOVE_PX = 10;

type Axis = 'h' | 'v' | 'pan' | null;

/**
 * Mobile-first photo viewer gestures (Telegram / WhatsApp):
 * - pinch zoom with rubber-band past min/max, settle on release
 * - double-tap toggle zoom at tap point
 * - one-finger pan while zoomed + inertia
 * - pull-down dismiss + horizontal album swipe only at 1×
 * - gesture painting via DOM (not React state) for 60fps
 */
export function ImageLightbox({ images, index, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [saving, setSaving] = useState(false);
  const [current, setCurrent] = useState(index);
  /** React state used for chrome (toolbar / nav) and backdrop only. */
  const [ui, setUi] = useState({
    zoomed: false,
    dragging: false,
    dragY: 0,
    chromeHidden: false,
  });

  const transformRef = useRef<Transform>({ ...IDENTITY });
  const animRef = useRef<number | null>(null);
  const dragYRef = useRef(0);
  const interactingRef = useRef(false);

  const touchRef = useRef<{
    x: number;
    y: number;
    t: number;
    axis: Axis;
    moved: boolean;
    /** Sample for velocity while panning. */
    lastX: number;
    lastY: number;
    lastT: number;
    vx: number;
    vy: number;
  } | null>(null);

  const pinchRef = useRef<{
    startDist: number;
    start: Transform;
    startMidX: number;
    startMidY: number;
  } | null>(null);

  const lastTapRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const suppressClickRef = useRef(false);
  const mousePanRef = useRef<{
    x: number;
    y: number;
    moved: boolean;
    lastX: number;
    lastY: number;
    lastT: number;
    vx: number;
    vy: number;
  } | null>(null);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const count = images.length;
  const clampIndex = (i: number) => (count ? (i + count) % count : 0);
  const active = images[clampIndex(current)];
  const multiple = count > 1;

  const stopAnim = () => {
    if (animRef.current != null) {
      cancelAnimationFrame(animRef.current);
      animRef.current = null;
    }
  };

  const metrics = () => {
    const root = rootRef.current;
    const img = imgRef.current;
    const viewW = root?.clientWidth || window.innerWidth;
    const viewH = root?.clientHeight || window.innerHeight;
    // Layout size at scale 1 (transforms don't affect offsetWidth).
    const imgW = img?.offsetWidth || viewW;
    const imgH = img?.offsetHeight || viewH;
    return { viewW, viewH, imgW, imgH };
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

  const paint = (t: Transform, dragY = 0, animateMs = 0) => {
    const img = imgRef.current;
    if (!img) return;
    const dismissProgress = Math.min(1, dragY / 280);
    const dismissScale = 1 - dismissProgress * 0.08;
    const scale = t.scale * (dragY ? dismissScale : 1);
    img.style.transition =
      animateMs > 0
        ? `transform ${animateMs}ms cubic-bezier(0.22, 1, 0.36, 1), opacity ${animateMs}ms ease`
        : 'none';
    img.style.transform = `translate3d(${t.tx}px, ${t.ty + dragY}px, 0) scale(${scale})`;
    img.style.opacity = String(1 - dismissProgress * 0.35);

    const root = rootRef.current;
    if (root) {
      const backdropAlpha = 0.92 * (1 - dismissProgress * 0.75);
      root.style.background = `rgba(0, 0, 0, ${backdropAlpha})`;
    }
  };

  const chromeHiddenRef = useRef(false);
  const zoomedRef = useRef(false);

  const setChromeHidden = (hidden: boolean) => {
    if (chromeHiddenRef.current === hidden) return;
    chromeHiddenRef.current = hidden;
    setUi((prev) => ({ ...prev, chromeHidden: hidden }));
  };

  const syncZoomed = () => {
    const zoomed = transformRef.current.scale > 1.01;
    if (zoomedRef.current === zoomed) return;
    zoomedRef.current = zoomed;
    setUi((prev) => ({ ...prev, zoomed }));
  };

  const setDraggingUi = (dragging: boolean, dragY = 0) => {
    setUi((prev) => {
      if (prev.dragging === dragging && prev.dragY === dragY) return prev;
      return { ...prev, dragging, dragY };
    });
  };

  const applyTransform = (next: Transform, opts?: { animate?: boolean; dragY?: number }) => {
    transformRef.current = next;
    const dragY = opts?.dragY ?? dragYRef.current;
    paint(next, dragY, opts?.animate ? SETTLE_MS : 0);
    syncZoomed();
  };

  const settle = (animate = true) => {
    const { imgW, imgH, viewW, viewH } = metrics();
    const next = settleTransform(transformRef.current, imgW, imgH, viewW, viewH);
    applyTransform(next, { animate });
  };

  const runInertia = (vx: number, vy: number) => {
    stopAnim();
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(32, now - last);
      last = now;
      vx *= INERTIA_FRICTION;
      vy *= INERTIA_FRICTION;
      if (Math.hypot(vx, vy) < INERTIA_MIN_V) {
        animRef.current = null;
        settle(true);
        interactingRef.current = false;
        setChromeHidden(false);
        setDraggingUi(false);
        return;
      }
      const { imgW, imgH, viewW, viewH } = metrics();
      const cur = transformRef.current;
      const next = rubberPan(
        cur.tx + vx * dt,
        cur.ty + vy * dt,
        cur.scale,
        imgW,
        imgH,
        viewW,
        viewH,
      );
      transformRef.current = { scale: cur.scale, tx: next.x, ty: next.y };
      paint(transformRef.current, 0, 0);
      animRef.current = requestAnimationFrame(step);
    };
    animRef.current = requestAnimationFrame(step);
  };

  const toggleDoubleTapZoom = (clientX: number, clientY: number) => {
    stopAnim();
    const { imgW, imgH, viewW, viewH } = metrics();
    const cur = transformRef.current;
    const focal = focalFromClient(clientX, clientY);
    if (cur.scale > 1.01) {
      applyTransform({ ...IDENTITY }, { animate: true });
    } else {
      applyTransform(
        zoomAround(cur, DOUBLE_TAP_SCALE, focal.x, focal.y, imgW, imgH, viewW, viewH),
        { animate: true },
      );
    }
    setChromeHidden(false);
    setDraggingUi(false);
  };

  const bumpZoom = (factor: number) => {
    stopAnim();
    const { imgW, imgH, viewW, viewH } = metrics();
    const cur = transformRef.current;
    applyTransform(zoomAround(cur, cur.scale * factor, 0, 0, imgW, imgH, viewW, viewH), {
      animate: true,
    });
  };

  useEffect(() => {
    setCurrent(index);
  }, [index]);

  useEffect(() => {
    stopAnim();
    transformRef.current = { ...IDENTITY };
    dragYRef.current = 0;
    pinchRef.current = null;
    touchRef.current = null;
    lastTapRef.current = null;
    interactingRef.current = false;
    chromeHiddenRef.current = false;
    zoomedRef.current = false;
    paint(IDENTITY, 0, 0);
    setUi({ zoomed: false, dragging: false, dragY: 0, chromeHidden: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, active?.src]);

  // Non-passive touch + wheel for preventDefault (blocks browser page zoom/scroll).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (transformRef.current.scale > 1.01) {
          applyTransform({ ...IDENTITY }, { animate: true });
          return;
        }
        onCloseRef.current();
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
      stopAnim();
      const { imgW, imgH, viewW, viewH } = metrics();
      const focal = focalFromClient(e.clientX, e.clientY);
      const cur = transformRef.current;
      const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_FACTOR);
      applyTransform(
        zoomAround(cur, cur.scale * factor, focal.x, focal.y, imgW, imgH, viewW, viewH),
      );
      suppressClickRef.current = true;
    };

    const beginPinch = (touches: TouchList) => {
      const a = touches[0];
      const b = touches[1];
      if (!a || !b) return;
      stopAnim();
      const mid = touchMidpoint(a, b);
      pinchRef.current = {
        startDist: Math.max(1, touchDistance(a, b)),
        start: { ...transformRef.current },
        startMidX: mid.x,
        startMidY: mid.y,
      };
      touchRef.current = null;
      dragYRef.current = 0;
      interactingRef.current = true;
      suppressClickRef.current = true;
      setChromeHidden(true);
      setDraggingUi(true, 0);
      paint(transformRef.current, 0, 0);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        beginPinch(e.touches);
        return;
      }
      const t = e.touches[0];
      if (!t) return;
      stopAnim();
      pinchRef.current = null;
      const now = Date.now();
      touchRef.current = {
        x: t.clientX,
        y: t.clientY,
        t: now,
        axis: transformRef.current.scale > 1.01 ? 'pan' : null,
        moved: false,
        lastX: t.clientX,
        lastY: t.clientY,
        lastT: now,
        vx: 0,
        vy: 0,
      };
      interactingRef.current = true;
      setChromeHidden(transformRef.current.scale > 1.01);
      setDraggingUi(true);
    };

    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();

      if (e.touches.length >= 2) {
        if (!pinchRef.current) beginPinch(e.touches);
        const pinch = pinchRef.current;
        const a = e.touches[0];
        const b = e.touches[1];
        if (!pinch || !a || !b) return;
        const { imgW, imgH, viewW, viewH } = metrics();
        const dist = Math.max(1, touchDistance(a, b));
        const mid = touchMidpoint(a, b);
        const startFocal = focalFromClient(pinch.startMidX, pinch.startMidY);
        const nextScale = pinch.start.scale * (dist / pinch.startDist);
        const zoomedAtStart = zoomAround(
          pinch.start,
          nextScale,
          startFocal.x,
          startFocal.y,
          imgW,
          imgH,
          viewW,
          viewH,
          true,
        );
        const pan = rubberPan(
          zoomedAtStart.tx + (mid.x - pinch.startMidX),
          zoomedAtStart.ty + (mid.y - pinch.startMidY),
          Math.max(zoomedAtStart.scale, 1),
          imgW,
          imgH,
          viewW,
          viewH,
        );
        transformRef.current = {
          scale: zoomedAtStart.scale,
          tx: pan.x,
          ty: pan.y,
        };
        paint(transformRef.current, 0, 0);
        return;
      }

      const start = touchRef.current;
      const t = e.touches[0];
      if (!start || !t || pinchRef.current) return;

      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      const now = Date.now();
      const dt = Math.max(1, now - start.lastT);
      // Track instantaneous velocity for inertia.
      start.vx = (t.clientX - start.lastX) / dt;
      start.vy = (t.clientY - start.lastY) / dt;
      start.lastX = t.clientX;
      start.lastY = t.clientY;
      start.lastT = now;

      if (Math.hypot(dx, dy) > TAP_MOVE_PX) start.moved = true;

      if (transformRef.current.scale > 1.01 || start.axis === 'pan') {
        start.axis = 'pan';
        const { imgW, imgH, viewW, viewH } = metrics();
        const cur = transformRef.current;
        const panDx = t.clientX - start.x;
        const panDy = t.clientY - start.y;
        const pan = rubberPan(
          cur.tx + panDx,
          cur.ty + panDy,
          cur.scale,
          imgW,
          imgH,
          viewW,
          viewH,
        );
        transformRef.current = { scale: cur.scale, tx: pan.x, ty: pan.y };
        start.x = t.clientX;
        start.y = t.clientY;
        paint(transformRef.current, 0, 0);
        setChromeHidden(true);
        return;
      }

      if (!start.axis) {
        if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
        start.axis = Math.abs(dy) > Math.abs(dx) ? 'v' : 'h';
        setChromeHidden(true);
      }

      if (start.axis === 'v') {
        // Telegram-style: only pull-down dismiss.
        const y = Math.max(0, dy);
        dragYRef.current = y;
        paint(transformRef.current, y, 0);
        setChromeHidden(true);
      } else if (start.axis === 'h' && multiple) {
        // Follow finger horizontally a bit for album feel (visual only until end).
        paint(
          { ...transformRef.current, tx: transformRef.current.tx + dx * 0.35 },
          0,
          0,
        );
      }
    };

    const finishPinch = (remaining?: Touch) => {
      pinchRef.current = null;
      settle(true);
      if (remaining && transformRef.current.scale > 1.01) {
        const now = Date.now();
        touchRef.current = {
          x: remaining.clientX,
          y: remaining.clientY,
          t: now,
          axis: 'pan',
          moved: true,
          lastX: remaining.clientX,
          lastY: remaining.clientY,
          lastT: now,
          vx: 0,
          vy: 0,
        };
        setChromeHidden(true);
        setDraggingUi(true, 0);
      } else {
        touchRef.current = null;
        interactingRef.current = false;
        setChromeHidden(false);
        setDraggingUi(false, 0);
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        beginPinch(e.touches);
        return;
      }

      if (e.touches.length === 1 && pinchRef.current) {
        finishPinch(e.touches[0]);
        return;
      }

      if (pinchRef.current) {
        finishPinch();
        return;
      }

      const start = touchRef.current;
      if (!start) {
        interactingRef.current = false;
        setChromeHidden(false);
        setDraggingUi(false);
        return;
      }

      const t = e.changedTouches[0];
      const endX = t?.clientX ?? start.x;
      const endY = t?.clientY ?? start.y;
      const dx = endX - start.x;
      const dy = endY - start.y;
      const dt = Math.max(1, Date.now() - start.t);
      const axis = start.axis;

      if (axis === 'pan' || transformRef.current.scale > 1.01) {
        if (start.moved) suppressClickRef.current = true;
        touchRef.current = null;
        dragYRef.current = 0;
        const speed = Math.hypot(start.vx, start.vy);
        if (start.moved && speed > INERTIA_MIN_V * 2) {
          runInertia(start.vx, start.vy);
        } else {
          settle(true);
          interactingRef.current = false;
          setChromeHidden(false);
        setDraggingUi(false, 0);
        }
        return;
      }

      if (axis === 'v' || (!axis && dy > 40 && Math.abs(dy) > Math.abs(dx))) {
        const vy = dy / dt;
        if (dragYRef.current > DISMISS_DY_PX || vy > DISMISS_VY) {
          onCloseRef.current();
          return;
        }
        dragYRef.current = 0;
        paint(transformRef.current, 0, SETTLE_MS);
        touchRef.current = null;
        interactingRef.current = false;
        setChromeHidden(false);
        setDraggingUi(false, 0);
        return;
      }

      if (multiple && (axis === 'h' || (!axis && Math.abs(dx) > SWIPE_H_PX))) {
        // Restore position then flip page.
        paint(transformRef.current, 0, 0);
        if (dx > SWIPE_H_PX) setCurrent((c) => clampIndex(c - 1));
        else if (dx < -SWIPE_H_PX) setCurrent((c) => clampIndex(c + 1));
        touchRef.current = null;
        interactingRef.current = false;
        setChromeHidden(false);
        setDraggingUi(false, 0);
        return;
      }

      // Tap / double-tap
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

      touchRef.current = null;
      dragYRef.current = 0;
      interactingRef.current = false;
      setChromeHidden(false);
        setDraggingUi(false, 0);
      paint(transformRef.current, 0, 0);
    };

    const onTouchCancel = () => {
      pinchRef.current = null;
      touchRef.current = null;
      dragYRef.current = 0;
      settle(true);
      interactingRef.current = false;
      setChromeHidden(false);
        setDraggingUi(false, 0);
    };

    window.addEventListener('keydown', onKey);
    root.addEventListener('wheel', onNativeWheel, { passive: false });
    root.addEventListener('touchstart', onTouchStart, { passive: true });
    root.addEventListener('touchmove', onTouchMove, { passive: false });
    root.addEventListener('touchend', onTouchEnd, { passive: true });
    root.addEventListener('touchcancel', onTouchCancel, { passive: true });

    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
      root.removeEventListener('wheel', onNativeWheel);
      root.removeEventListener('touchstart', onTouchStart);
      root.removeEventListener('touchmove', onTouchMove);
      root.removeEventListener('touchend', onTouchEnd);
      root.removeEventListener('touchcancel', onTouchCancel);
      stopAnim();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, count, multiple, current]);

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

  const onMouseDown = (e: ReactMouseEvent) => {
    if (e.button !== 0 || transformRef.current.scale <= 1.01) return;
    e.preventDefault();
    e.stopPropagation();
    stopAnim();
    const now = Date.now();
    mousePanRef.current = {
      x: e.clientX,
      y: e.clientY,
      moved: false,
      lastX: e.clientX,
      lastY: e.clientY,
      lastT: now,
      vx: 0,
      vy: 0,
    };
    setChromeHidden(true);
    setDraggingUi(true);
  };

  const onMouseMove = (e: ReactMouseEvent) => {
    const pan = mousePanRef.current;
    if (!pan) return;
    const now = Date.now();
    const dt = Math.max(1, now - pan.lastT);
    pan.vx = (e.clientX - pan.lastX) / dt;
    pan.vy = (e.clientY - pan.lastY) / dt;
    pan.lastX = e.clientX;
    pan.lastY = e.clientY;
    pan.lastT = now;
    const dx = e.clientX - pan.x;
    const dy = e.clientY - pan.y;
    if (Math.hypot(dx, dy) > TAP_MOVE_PX) pan.moved = true;
    const { imgW, imgH, viewW, viewH } = metrics();
    const cur = transformRef.current;
    const next = rubberPan(cur.tx + dx, cur.ty + dy, cur.scale, imgW, imgH, viewW, viewH);
    transformRef.current = { scale: cur.scale, tx: next.x, ty: next.y };
    pan.x = e.clientX;
    pan.y = e.clientY;
    paint(transformRef.current, 0, 0);
  };

  const endMousePan = () => {
    const pan = mousePanRef.current;
    if (!pan) return;
    if (pan.moved) suppressClickRef.current = true;
    mousePanRef.current = null;
    const speed = Math.hypot(pan.vx, pan.vy);
    if (pan.moved && speed > INERTIA_MIN_V * 2) {
      runInertia(pan.vx, pan.vy);
    } else {
      settle(true);
      setChromeHidden(false);
        setDraggingUi(false);
    }
  };

  const onDoubleClick = (e: ReactMouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    toggleDoubleTapZoom(e.clientX, e.clientY);
    suppressClickRef.current = true;
  };

  const onImgClick = (e: ReactMouseEvent) => {
    e.stopPropagation();
  };

  const onBackdropClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (transformRef.current.scale > 1.01) {
      applyTransform({ ...IDENTITY }, { animate: true });
      return;
    }
    onClose();
  };

  if (!active) return null;

  const chromeGone = ui.chromeHidden || (ui.dragging && ui.dragY > 0);

  return (
    <div
      ref={rootRef}
      className={`image-lightbox${ui.dragging ? ' is-dragging' : ''}${ui.zoomed ? ' is-zoomed' : ''}${chromeGone ? ' is-chrome-hidden' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Просмотр фото"
      onClick={onBackdropClick}
      onMouseMove={onMouseMove}
      onMouseUp={endMousePan}
      onMouseLeave={endMousePan}
    >
      <img
        ref={imgRef}
        key={active.src}
        className="image-lightbox-img"
        src={active.src}
        alt=""
        onClick={onImgClick}
        onDoubleClick={onDoubleClick}
        onMouseDown={onMouseDown}
        draggable={false}
        onLoad={() => paint(transformRef.current, dragYRef.current, 0)}
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

      {multiple && !ui.zoomed && (
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

      {multiple && !ui.zoomed && (
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
