import type { StoredMessage } from '../lib/storage';
import { useTransferProgress } from '../hooks/useTransferProgress';
import { MessageStatus } from './MessageStatus';
import { formatMessageTime } from '../lib/chat-format';

interface Props {
  message: StoredMessage;
  isOwn: boolean;
  read: boolean;
  onOpen: () => void;
}

export function ChatImageBubble({ message, isOwn, read, onOpen }: Props) {
  const transfer = useTransferProgress(message);
  const queued = transfer?.kind === 'queued';
  const showProgress =
    transfer != null && (queued || transfer.kind === 'upload' || transfer.kind === 'download') &&
    (queued || transfer.percent < 100 || message.pending);
  const label = queued
    ? 'В очереди'
    : transfer?.kind === 'upload'
      ? `Отправка ${transfer.percent}%`
      : transfer?.kind === 'download'
        ? `Загрузка ${transfer.percent}%`
        : null;

  return (
    <>
      <button
        type="button"
        className={`msg-image-btn${showProgress ? ' transferring' : ''}${queued ? ' queued' : ''}`}
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
      <time className="message-meta">
        {formatMessageTime(message.createdAt)}
        {isOwn && <MessageStatus pending={!!message.pending} read={read} />}
      </time>
    </>
  );
}
