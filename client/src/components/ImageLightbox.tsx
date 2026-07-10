import { useEffect } from 'react';
import { notify } from '../lib/notify';

interface Props {
  src: string;
  onClose: () => void;
}

async function saveImage(src: string) {
  const res = await fetch(src);
  const blob = await res.blob();
  const ext = blob.type.includes('png')
    ? 'png'
    : blob.type.includes('webp')
      ? 'webp'
      : 'jpg';
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = `photo-${Date.now()}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}

export function ImageLightbox({ src, onClose }: Props) {
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
    try {
      await saveImage(src);
      notify.success('Фото сохранено');
    } catch {
      notify.error('Не удалось сохранить фото');
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
        <button type="button" className="image-lightbox-btn" onClick={() => void onSave()}>
          Сохранить
        </button>
        <button type="button" className="image-lightbox-btn" onClick={onClose} aria-label="Закрыть">
          Закрыть
        </button>
      </div>
      <img
        className="image-lightbox-img"
        src={src}
        alt=""
        onClick={(e) => e.stopPropagation()}
        draggable={false}
      />
    </div>
  );
}
