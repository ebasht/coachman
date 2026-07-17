import { useEffect, useRef, useState } from 'react';
import { notify } from '../lib/notify';
import { saveChatImage } from '../lib/save-image';

interface Props {
  src: string;
  imageId?: string | null;
  messageId?: string | null;
  onClose: () => void;
}

export function ImageLightbox({ src, imageId, messageId, onClose }: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const onSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const result = await saveChatImage({ src, imageId, messageId });
      if (result === 'saved') notify.success('Фото сохранено');
    } catch {
      notify.error('Не удалось сохранить фото');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Просмотр фото"
      onClick={onClose}
    >
      <div className="image-lightbox-toolbar" onClick={(e) => e.stopPropagation()}>
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
      <img
        ref={imgRef}
        className="image-lightbox-img"
        src={src}
        alt=""
        onClick={(e) => e.stopPropagation()}
        draggable={false}
      />
    </div>
  );
}
