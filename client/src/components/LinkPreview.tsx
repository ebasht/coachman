import { useEffect, useState } from 'react';
import { extractFirstUrl } from '../lib/link-detect';
import { fetchLinkPreview, type LinkPreviewData } from '../lib/link-preview';

interface Props {
  text: string;
}

export function LinkPreview({ text }: Props) {
  const url = extractFirstUrl(text);
  const [preview, setPreview] = useState<LinkPreviewData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!url) {
      setPreview(null);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    void fetchLinkPreview(url).then((data) => {
      if (!active) return;
      setPreview(data);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [url]);

  if (!url) return null;
  if (!preview) {
    if (!loading) return null;
    let host = url;
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      // keep raw
    }
    return (
      <a className="link-preview is-loading" href={url} target="_blank" rel="noopener noreferrer">
        <span className="link-preview-accent" aria-hidden />
        <span className="link-preview-body">
          <span className="link-preview-site">{host}</span>
          <span className="link-preview-title">Загрузка превью…</span>
        </span>
      </a>
    );
  }

  const title = preview.title || preview.siteName || (() => {
    try {
      return new URL(preview.url).hostname;
    } catch {
      return preview.url;
    }
  })();
  const host = (() => {
    try {
      return new URL(preview.url).hostname.replace(/^www\./, '');
    } catch {
      return preview.url;
    }
  })();

  return (
    <a className="link-preview" href={preview.url} target="_blank" rel="noopener noreferrer">
      <span className="link-preview-accent" aria-hidden />
      <span className="link-preview-body">
        <span className="link-preview-site">{preview.siteName || host}</span>
        <span className="link-preview-title">{title}</span>
        {preview.description && (
          <span className="link-preview-description">{preview.description}</span>
        )}
      </span>
      {preview.image && isSafeHttpUrl(preview.image) && (
        <img className="link-preview-image" src={preview.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
      )}
    </a>
  );
}

function isSafeHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
