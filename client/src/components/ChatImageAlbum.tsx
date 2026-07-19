import type { StoredMessage } from '../lib/storage';
import { useTransferProgress } from '../hooks/useTransferProgress';
import { MessageStatus } from './MessageStatus';
import { formatMessageTime } from '../lib/chat-format';
import { retryOutboxItem } from '../lib/outbox';

interface Props {
  messages: StoredMessage[];
  isOwn: boolean;
  read: boolean;
  onOpen: (index: number) => void;
}

const MAX_TILES = 4;

function AlbumTile({
  message,
  hiddenCount,
  onOpen,
}: {
  message: StoredMessage;
  hiddenCount: number;
  onOpen: () => void;
}) {
  const transfer = useTransferProgress(message);
  const failed = !!message.failed;
  const queued = !failed && transfer?.kind === 'queued';
  const uploading = !failed && transfer?.kind === 'upload';
  const downloading = !failed && transfer?.kind === 'download';
  const busy =
    queued || (uploading && transfer.percent < 100) || (downloading && transfer.percent < 100);

  return (
    <button
      type="button"
      className={`msg-album-tile${busy ? ' transferring' : ''}${failed ? ' failed' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        if (failed) {
          void retryOutboxItem(message.id);
          return;
        }
        if (message.imageUrl) onOpen();
      }}
      disabled={!message.imageUrl && !failed}
    >
      {message.imageUrl ? (
        <img src={message.imageUrl} alt="Изображение" className="msg-album-img" loading="lazy" />
      ) : (
        <div className="msg-album-placeholder" aria-hidden />
      )}
      {busy && (
        <div className="msg-album-spinner" aria-hidden>
          <span className="msg-album-spinner-ring" />
        </div>
      )}
      {failed && (
        <div className="msg-album-tile-error" role="alert">
          <span>Ошибка</span>
          <span className="msg-album-retry">Повторить</span>
        </div>
      )}
      {hiddenCount > 0 && (
        <div className="msg-album-more" aria-hidden>
          <span className="msg-album-more-count">+{hiddenCount}</span>
          <span className="msg-album-more-label">фото</span>
        </div>
      )}
    </button>
  );
}

export function ChatImageAlbum({ messages, isOwn, read, onOpen }: Props) {
  const total = messages.length;
  const tiles = messages.slice(0, MAX_TILES);
  const pending = messages.some((m) => m.pending);

  return (
    <>
      <div
        className={`msg-album count-${Math.min(total, MAX_TILES)}`}
        role="group"
        aria-label={`Альбом из ${total} фото`}
      >
        {tiles.map((m, idx) => {
          const isLastTile = idx === tiles.length - 1 && total > MAX_TILES;
          // Remaining photos beyond the 4 visible tiles (Telegram-style).
          const hiddenCount = isLastTile ? total - MAX_TILES : 0;
          return (
            <AlbumTile
              key={m.id}
              message={m}
              hiddenCount={hiddenCount}
              onOpen={() => onOpen(idx)}
            />
          );
        })}
      </div>
      <time className="message-meta">
        {formatMessageTime(messages[messages.length - 1].createdAt)}
        {isOwn && <MessageStatus pending={pending} read={read} />}
      </time>
    </>
  );
}
