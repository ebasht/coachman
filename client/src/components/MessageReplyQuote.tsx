import type { StoredMessage } from '../lib/storage';

interface Props {
  message: StoredMessage;
  onOpen?: () => void;
}

/** Telegram-style quote strip inside a bubble / compose preview. */
export function MessageReplyQuote({ message, onOpen }: Props) {
  if (!message.replyToMessageId) return null;
  const author = message.replyToSenderName || '…';
  const preview = message.replyToPreview || 'Сообщение';
  return (
    <button
      type="button"
      className="message-reply"
      onClick={(e) => {
        e.stopPropagation();
        onOpen?.();
      }}
    >
      <span className="message-reply-bar" aria-hidden />
      <span className="message-reply-body">
        <span className="message-reply-author">{author}</span>
        <span className="message-reply-text">{preview}</span>
      </span>
    </button>
  );
}
