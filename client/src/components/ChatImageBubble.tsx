import type { StoredMessage } from '../lib/storage';
import { useTransferProgress } from '../hooks/useTransferProgress';
import { MessageStatus } from './MessageStatus';
import { formatMessageTime } from '../lib/chat-format';
import { retryOutboxItem } from '../lib/outbox';

interface Props {
  message: StoredMessage;
  isOwn: boolean;
  read: boolean;
  onOpen: () => void;
}

export function ChatImageBubble({ message, isOwn, read, onOpen }: Props) {
  const transfer = useTransferProgress(message);
  const failed = !!message.failed;
  const queued = !failed && transfer?.kind === 'queued';
  const uploading = !failed && transfer?.kind === 'upload';
  const downloading = !failed && transfer?.kind === 'download';
  const showProgress =
    queued || (uploading && transfer.percent < 100) || (downloading && transfer.percent < 100);
  const label = queued
    ? 'В очереди'
    : uploading
      ? `Отправка ${transfer.percent}%`
      : downloading
        ? `Загрузка ${transfer.percent}%`
        : null;

  return (
    <>
      <button
        type="button"
        className={`msg-image-btn${showProgress ? ' transferring' : ''}${queued ? ' queued' : ''}${failed ? ' failed' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          if (message.imageUrl) onOpen();
        }}
        disabled={!message.imageUrl}
      >
        {message.imageUrl ? (
          <img src={message.imageUrl} alt="Изображение" className="msg-image" loading="lazy" />
        ) : (
          <div className="msg-image-placeholder" aria-hidden />
        )}
        {showProgress && label && (
          <div className="msg-image-progress" aria-live="polite">
            {!queued && (
              <div
                className="msg-image-progress-bar"
                style={{ width: `${transfer?.percent ?? 0}%` }}
              />
            )}
            <span className="msg-image-progress-label">{label}</span>
          </div>
        )}
      </button>
      {failed && (
        <div className="msg-image-error" role="alert">
          <span className="msg-image-error-text">
            Не удалось отправить фото{message.error ? `: ${message.error}` : ''}
          </span>
          <button
            type="button"
            className="msg-image-retry"
            onClick={(e) => {
              e.stopPropagation();
              void retryOutboxItem(message.id);
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
