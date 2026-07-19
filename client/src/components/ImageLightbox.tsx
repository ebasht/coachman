import { useEffect, useRef, useState, type TouchEvent } from 'react';
import { notify } from '../lib/notify';
import { saveChatImage } from '../lib/save-image';

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

export function ImageLightbox({ images, index, onClose }: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [saving, setSaving] = useState(false);
  const [current, setCurrent] = useState(index);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const touchRef = useRef<{
    x: number;
    y: number;
    t: number;
    axis: 'h' | 'v' | null;
  } | null>(null);

  const count = images.length;
  const clamp = (i: number) => (count ? (i + count) % count : 0);
  const active = images[clamp(current)];

  useEffect(() => {
    setCurrent(index);
  }, [index]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') setCurrent((c) => clamp(c - 1));
      else if (e.key === 'ArrowRight') setCurrent((c) => clamp(c + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
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

  const goPrev = () => setCurrent((c) => clamp(c - 1));
  const goNext = () => setCurrent((c) => clamp(c + 1));
  const multiple = count > 1;

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
      // Only pull-down dismiss (Telegram-style); ignore upward.
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
      resetDrag();
      return;
    }

    if (multiple && (axis === 'h' || (!axis && Math.abs(dx) > SWIPE_H_PX))) {
      if (dx > SWIPE_H_PX) goPrev();
      else if (dx < -SWIPE_H_PX) goNext();
    }
    resetDrag();
  };

  if (!active) return null;

  const dismissProgress = Math.min(1, dragY / 280);
  const backdropAlpha = 0.92 * (1 - dismissProgress * 0.75);

  return (
    <div
      className={`image-lightbox${dragging && dragY > 0 ? ' is-dragging' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Просмотр фото"
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
        {multiple && (
          <span className="image-lightbox-counter" aria-live="polite">
            {clamp(current) + 1} / {count}
          </span>
        )}
        <button
          type="button"
          className="image-lightbox-btn"
          disabled={saving}
          onClick={() => void onSave()}
        >
          {saving ? 'Сохранение…' : 'Сохранить'}
        </button>
        <button type="button" className="image-lightbox-btn" onClick={onClose} aria-label="Закрыть">
          Закрыть
        </button>
      </div>

      {multiple && (
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

      <img
        ref={imgRef}
        key={active.src}
        className="image-lightbox-img"
        src={active.src}
        alt=""
        onClick={(e) => e.stopPropagation()}
        draggable={false}
        style={{
          transform: dragY ? `translateY(${dragY}px) scale(${1 - dismissProgress * 0.08})` : undefined,
          opacity: 1 - dismissProgress * 0.35,
          transition: dragging ? 'none' : 'transform 0.2s ease, opacity 0.2s ease',
        }}
      />

      {multiple && (
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
