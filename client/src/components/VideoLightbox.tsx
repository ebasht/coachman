import { useEffect, useRef, useState, type TouchEvent } from 'react';

interface Props {
  src: string;
  onClose: () => void;
}

const DISMISS_DY_PX = 120;
const DISMISS_VY = 0.65;

export function VideoLightbox({ src, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const touchRef = useRef<{
    x: number;
    y: number;
    t: number;
    axis: 'h' | 'v' | null;
  } | null>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const v = videoRef.current;
    void v?.play().catch(() => {
      /* autoplay may be blocked — controls remain */
    });
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, src]);

  const resetDrag = () => {
    touchRef.current = null;
    setDragging(false);
    setDragY(0);
  };

  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    touchRef.current = { x: t.clientX, y: t.clientY, t: Date.now(), axis: null };
    setDragging(true);
  };

  const onTouchMove = (e: TouchEvent) => {
    const start = touchRef.current;
    const t = e.touches[0];
    if (!start || !t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (!start.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      start.axis = Math.abs(dy) > Math.abs(dx) ? 'v' : 'h';
    }
    if (start.axis === 'v') {
      setDragY(Math.max(0, dy));
    }
  };

  const onTouchEnd = (e: TouchEvent) => {
    const start = touchRef.current;
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = (t?.clientX ?? start.x) - start.x;
    const dy = (t?.clientY ?? start.y) - start.y;
    const dt = Math.max(1, Date.now() - start.t);
    const axis = start.axis;
    if (axis === 'v' || (!axis && dy > 40 && Math.abs(dy) > Math.abs(dx))) {
      const vy = dy / dt;
      if (dy > DISMISS_DY_PX || vy > DISMISS_VY) {
        onClose();
        return;
      }
    }
    resetDrag();
  };

  const dismissProgress = Math.min(1, dragY / 280);
  const backdropAlpha = 0.92 * (1 - dismissProgress * 0.75);

  return (
    <div
      className={`image-lightbox video-lightbox${dragging && dragY > 0 ? ' is-dragging' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Просмотр видео"
      style={{ background: `rgba(0, 0, 0, ${backdropAlpha})` }}
      onClick={onClose}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={resetDrag}
    >
      <div
        className="image-lightbox-toolbar"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        <button type="button" className="image-lightbox-btn" onClick={onClose} aria-label="Закрыть">
          Закрыть
        </button>
      </div>

      <video
        ref={videoRef}
        key={src}
        className="image-lightbox-img video-lightbox-video"
        src={src}
        controls
        playsInline
        onClick={(e) => e.stopPropagation()}
        style={{
          transform: dragY ? `translateY(${dragY}px) scale(${1 - dismissProgress * 0.08})` : undefined,
          opacity: 1 - dismissProgress * 0.35,
          transition: dragging ? 'none' : 'transform 0.2s ease, opacity 0.2s ease',
        }}
      />
    </div>
  );
}
