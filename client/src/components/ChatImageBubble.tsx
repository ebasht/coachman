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
  const showProgress = transfer != null && transfer.percent < 100;
  const label =
    transfer?.kind === 'upload'
      ? `Отправка ${transfer.percent}%`
      : transfer?.kind === 'download'
        ? `Загрузка ${transfer.percent}%`
        : null;

  return (
    <>
      <button
        type="button"
        className={`msg-image-btn${showProgress ? ' transferring' : ''}`}
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
        {showProgress && (
          <div className="msg-image-progress" aria-live="polite">
            <div
              className="msg-image-progress-bar"
              style={{ width: `${transfer.percent}%` }}
            />
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
