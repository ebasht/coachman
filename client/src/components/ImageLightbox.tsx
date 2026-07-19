import { useEffect, useRef, useState } from 'react';
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

export function ImageLightbox({ images, index, onClose }: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [saving, setSaving] = useState(false);
  const [current, setCurrent] = useState(index);
  const touchStartX = useRef<number | null>(null);

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

  if (!active) return null;

  return (
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Просмотр фото"
      onClick={onClose}
    >
      <div className="image-lightbox-toolbar" onClick={(e) => e.stopPropagation()}>
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
        onTouchStart={(e) => {
          touchStartX.current = e.touches[0]?.clientX ?? null;
        }}
        onTouchEnd={(e) => {
          if (touchStartX.current == null || !multiple) return;
          const dx = (e.changedTouches[0]?.clientX ?? 0) - touchStartX.current;
          touchStartX.current = null;
          if (dx > 50) goPrev();
          else if (dx < -50) goNext();
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
        >
          <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden>
            <path fill="currentColor" d="m8.6 7.4 1.4-1.4 6 6-6 6-1.4-1.4L13.2 12z" />
          </svg>
        </button>
      )}
    </div>
  );
}
