import { useEffect, useState } from 'react';
import { useTransferProgress } from '../hooks/useTransferProgress';
import type { StoredMessage } from '../lib/storage';
import { formatMessageTime } from '../lib/chat-format';
import { retryOutboxItem } from '../lib/outbox';
import { ensureVideoPoster } from '../lib/video-preview';
import { MessageStatus } from './MessageStatus';
import { MediaDeleteButton } from './MediaDeleteButton';

interface Props {
  message: StoredMessage;
  isOwn: boolean;
  read: boolean;
  onOpen: () => void;
  onDelete?: () => void;
}

export function ChatVideoBubble({ message, isOwn, read, onOpen, onDelete }: Props) {
  const transfer = useTransferProgress(message);
  const [posterUrl, setPosterUrl] = useState(message.posterUrl);
  const failed = !!message.failed;
  const pendingMedia = !failed && !message.imageUrl;
  const queued = !failed && transfer?.kind === 'queued';
  const uploading = !failed && transfer?.kind === 'upload';
  const downloading = !failed && transfer?.kind === 'download';
  const showBar =
    (uploading || downloading) && transfer != null && transfer.percent < 100;
  const showProgress = queued || showBar || pendingMedia;
  const label = queued
    ? 'В очереди'
    : uploading
      ? `Отправка ${transfer!.percent}%`
      : downloading
        ? `Загрузка ${transfer!.percent}%`
        : pendingMedia
          ? 'Загрузка…'
          : null;

  useEffect(() => {
    setPosterUrl(message.posterUrl);
  }, [message.posterUrl, message.id]);

  useEffect(() => {
    if (posterUrl || !message.imageUrl || message.type !== 'video') return;
    let cancelled = false;
    void ensureVideoPoster(message, message.imageUrl).then((url) => {
      if (!cancelled && url) setPosterUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [posterUrl, message.imageUrl, message.id, message.type, message.imageId]);

  const canOpen = !!message.imageUrl;

  return (
    <>
      <div className="msg-media-wrap">
        <button
          type="button"
          className={`msg-image-btn msg-video-btn${showProgress ? ' transferring' : ''}${queued || pendingMedia ? ' queued' : ''}${failed ? ' failed' : ''}${pendingMedia ? ' pending-media' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            if (canOpen) onOpen();
          }}
          disabled={!canOpen}
          aria-label="Открыть видео"
        >
          {posterUrl ? (
            <img
              src={posterUrl}
              alt=""
              className="msg-image msg-video"
              loading="lazy"
              draggable={false}
              onContextMenu={(e) => e.preventDefault()}
            />
          ) : message.imageUrl ? (
            <video
              src={`${message.imageUrl}#t=0.1`}
              className="msg-image msg-video"
              muted
              playsInline
              preload="metadata"
              aria-hidden
              onContextMenu={(e) => e.preventDefault()}
            />
          ) : (
            <div className="msg-image-placeholder msg-video-placeholder" aria-hidden />
          )}
          {!showProgress && (
            <span className="msg-video-play" aria-hidden>
              <svg viewBox="0 0 24 24" width="22" height="22" focusable="false">
                <path fill="currentColor" d="M8 5v14l11-7z" />
              </svg>
            </span>
          )}
          {showProgress && label && (
            <div className="msg-image-progress" aria-live="polite">
              {showBar && (
                <div
                  className="msg-image-progress-bar"
                  style={{ width: `${transfer!.percent}%` }}
                />
              )}
              <span className="msg-image-progress-label">{label}</span>
            </div>
          )}
        </button>
        {isOwn && onDelete && <MediaDeleteButton onDelete={onDelete} label="Удалить видео" />}
      </div>
      {failed && (
        <div className="msg-image-error" role="alert">
          <span className="msg-image-error-text">
            Не удалось отправить видео{message.error ? `: ${message.error}` : ''}
          </span>
          <button
            type="button"
            className="msg-image-retry"
            onClick={(e) => {
              e.stopPropagation();
              void retryOutboxItem(message.clientId || message.id);
            }}
          >
            Повторить
          </button>
        </div>
      )}
      <time className="message-meta">
        {formatMessageTime(message.createdAt)}
        {isOwn && <MessageStatus pending={!!message.pending} read={read} />}
      </time>
    </>
  );
}
