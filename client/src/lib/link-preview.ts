import { api } from './api';

export interface LinkPreviewData {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

const cache = new Map<string, LinkPreviewData>();
const inflight = new Map<string, Promise<LinkPreviewData | null>>();

function fallbackPreview(url: string): LinkPreviewData {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return { url, title: host, siteName: host };
  } catch {
    return { url, title: url, siteName: url };
  }
}

export async function fetchLinkPreview(url: string): Promise<LinkPreviewData | null> {
  const cached = cache.get(url);
  if (cached) return cached;

  let pending = inflight.get(url);
  if (!pending) {
    pending = api
      .unfurl(url)
      .then((data) => {
        const preview: LinkPreviewData = {
          url: data.url || url,
          title: data.title || data.siteName,
          description: data.description,
          image: data.image,
          siteName: data.siteName,
        };
        if (!preview.title && !preview.description && !preview.image) {
          return fallbackPreview(url);
        }
        cache.set(url, preview);
        return preview;
      })
      .catch(() => {
        const preview = fallbackPreview(url);
        // Short-lived negative path: still show something, cache so we don't hammer API.
        cache.set(url, preview);
        return preview;
      })
      .finally(() => {
        inflight.delete(url);
      });
    inflight.set(url, pending);
  }
  return pending;
}
