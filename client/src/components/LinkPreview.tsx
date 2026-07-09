import { useEffect, useState } from 'react';
import { extractFirstUrl } from '../lib/link-detect';
import { fetchLinkPreview, type LinkPreviewData } from '../lib/link-preview';

interface Props {
  text: string;
}

export function LinkPreview({ text }: Props) {
  const url = extractFirstUrl(text);
  const [preview, setPreview] = useState<LinkPreviewData | null>(null);

  useEffect(() => {
    if (!url) {
      setPreview(null);
      return;
    }
    let active = true;
    void fetchLinkPreview(url).then((data) => {
      if (active) setPreview(data);
    });
    return () => {
      active = false;
    };
  }, [url]);

  if (!url || !preview) return null;

  const title = preview.title || preview.siteName || new URL(preview.url).hostname;
  const host = (() => {
    try {
      return new URL(preview.url).hostname;
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
      {preview.image && (
        <img className="link-preview-image" src={preview.image} alt="" loading="lazy" />
      )}
    </a>
  );
}
