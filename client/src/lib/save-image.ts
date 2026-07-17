import { getCachedImage } from './storage';
import { localPreviewKey } from './image-preview';

export type SaveImageResult = 'saved' | 'cancelled';

function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('heic')) return 'heic';
  if (m.includes('heif')) return 'heif';
  if (m.includes('bmp')) return 'bmp';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  return 'bin';
}

function defaultFilename(mime: string): string {
  return `yamshchik-${Date.now()}.${extFromMime(mime)}`;
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

async function blobFromSrc(src: string): Promise<Blob> {
  // CSP allows blob: in connect-src — keep original bytes, no re-encode.
  const res = await fetch(src);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

async function resolveOriginalBlob(opts: {
  src: string;
  imageId?: string | null;
  messageId?: string | null;
}): Promise<{ blob: Blob; filename: string }> {
  if (opts.imageId) {
    const cached = await getCachedImage(opts.imageId);
    if (cached?.data.byteLength) {
      const mime = cached.mimeType || 'application/octet-stream';
      return {
        blob: new Blob([cached.data], { type: mime }),
        filename: defaultFilename(mime),
      };
    }
  }
  if (opts.messageId) {
    const local = await getCachedImage(localPreviewKey(opts.messageId));
    if (local?.data.byteLength) {
      const mime = local.mimeType || 'application/octet-stream';
      return {
        blob: new Blob([local.data], { type: mime }),
        filename: defaultFilename(mime),
      };
    }
  }

  const blob = await blobFromSrc(opts.src);
  const mime = blob.type || 'application/octet-stream';
  return { blob, filename: defaultFilename(mime) };
}

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: { description?: string; accept: Record<string, string[]> }[];
  }) => Promise<{
    createWritable: () => Promise<{
      write: (data: Blob) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
};

async function saveWithFilePicker(blob: Blob, filename: string): Promise<boolean> {
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
  if (typeof picker !== 'function') return false;
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1) : 'bin';
  const mime = blob.type || 'application/octet-stream';
  try {
    const handle = await picker.call(window, {
      suggestedName: filename,
      types: [
        {
          description: 'Image',
          accept: { [mime]: [`.${ext}`] },
        },
      ],
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return false;
  }
}

async function shareBlob(blob: Blob, filename: string): Promise<'saved' | 'cancelled' | 'unsupported'> {
  const nav = navigator as Navigator & {
    canShare?: (data?: ShareData) => boolean;
  };
  if (typeof nav.share !== 'function') return 'unsupported';

  const type = blob.type || 'application/octet-stream';
  const file = new File([blob], filename, { type });
  try {
    if (typeof nav.canShare === 'function' && !nav.canShare({ files: [file] })) {
      return 'unsupported';
    }
    await nav.share({ files: [file], title: 'Фото' });
    return 'saved';
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
    return 'unsupported';
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  try {
    triggerDownload(objectUrl, filename);
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  }
}

/** Save chat photo at original quality (cache / blob URL), no canvas re-encode. */
export async function saveChatImage(opts: {
  src: string;
  imageId?: string | null;
  messageId?: string | null;
}): Promise<SaveImageResult> {
  const { blob, filename } = await resolveOriginalBlob(opts);

  try {
    if (await saveWithFilePicker(blob, filename)) return 'saved';
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
  }

  // Mobile / PWA: share sheet (Save Image) is more reliable than <a download>.
  // Desktop: share is optional; download still works as fallback.
  const shared = await shareBlob(blob, filename);
  if (shared === 'saved' || shared === 'cancelled') return shared;

  downloadBlob(blob, filename);
  return 'saved';
}
