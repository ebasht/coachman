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

export async function fetchLinkPreview(url: string): Promise<LinkPreviewData | null> {
  const cached = cache.get(url);
  if (cached) return cached;

  let pending = inflight.get(url);
  if (!pending) {
    pending = api
      .unfurl(url)
      .then((data) => {
        cache.set(url, data);
        return data;
      })
      .catch(() => null)
      .finally(() => {
        inflight.delete(url);
      });
    inflight.set(url, pending);
  }
  return pending;
}
