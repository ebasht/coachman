import { useEffect, useRef } from 'react';
import { notify } from '../lib/notify';

interface Props {
  src: string;
  onClose: () => void;
}

function extFromMime(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'jpg';
}

function triggerDownload(href: string, filename: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function blobFromImageElement(img: HTMLImageElement): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  if (!canvas.width || !canvas.height) throw new Error('empty image');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.drawImage(img, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', 0.92);
  });
  if (!blob) throw new Error('toBlob failed');
  return blob;
}

async function shareOrDownloadBlob(blob: Blob, filename: string): Promise<'saved' | 'cancelled'> {
  const file = new File([blob], filename, { type: blob.type || 'image/jpeg' });
  const nav = navigator as Navigator & {
    canShare?: (data?: ShareData) => boolean;
  };
  if (typeof nav.share === 'function' && typeof nav.canShare === 'function') {
    try {
      if (nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: filename });
        return 'saved';
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
      // Share failed — fall through to <a download>.
    }
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    triggerDownload(objectUrl, filename);
  } finally {
    // Delay revoke so the browser can start the download.
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 2_000);
  }
  return 'saved';
}

async function saveImage(
  src: string,
  img: HTMLImageElement | null,
): Promise<'saved' | 'cancelled'> {
  // Chat photos are blob: URLs. fetch(blob:) is blocked when CSP connect-src
  // omits blob: — download via canvas / object URL instead.
  if (src.startsWith('blob:') || src.startsWith('data:')) {
    const filename = `photo-${Date.now()}.jpg`;
    if (img?.complete && (img.naturalWidth > 0 || img.width > 0)) {
      try {
        const blob = await blobFromImageElement(img);
        return await shareOrDownloadBlob(blob, `photo-${Date.now()}.${extFromMime(blob.type)}`);
      } catch {
        // fall through to direct link download
      }
    }
    triggerDownload(src, filename);
    return 'saved';
  }

  const res = await fetch(src);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return shareOrDownloadBlob(blob, `photo-${Date.now()}.${extFromMime(blob.type)}`);
}

export function ImageLightbox({ src, onClose }: Props) {
  const imgRef = useRef<HTMLImageElement>(null);

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
      const result = await saveImage(src, imgRef.current);
      if (result === 'saved') notify.success('Фото сохранено');
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
