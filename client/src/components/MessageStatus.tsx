interface Props {
  pending?: boolean;
  read?: boolean;
}

/** Clock = not on server yet; single/double check = delivered / read. */
export function MessageStatus({ pending, read }: Props) {
  if (pending) {
    return (
      <span className="msg-status pending" aria-label="Не отправлено" title="Не отправлено">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.35" />
          <path
            d="M8 4.25v4.1l2.35 1.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }

  const label = read ? 'Прочитано' : 'Доставлено';

  return (
    <span className={`msg-status ${read ? 'read' : 'sent'}`} aria-label={label}>
      <svg viewBox="0 0 16 11" width="16" height="11" aria-hidden>
        <path
          d="M11.071.653a.457.457 0 0 0-.512.058L4.13 6.548 1.441 4.28a.53.53 0 0 0-.705.039l-.776.81a.477.477 0 0 0 .04.706l3.6 3.292a.53.53 0 0 0 .705-.04l7.2-7.763a.48.48 0 0 0-.04-.706l-.778-.81z"
          fill="currentColor"
        />
        {read && (
          <path
            d="M15.512.653a.457.457 0 0 0-.512.058l-6.43 5.837-1.35-1.218a.53.53 0 0 0-.705.039l-.776.81a.477.477 0 0 0 .04.706l2.17 1.98a.53.53 0 0 0 .705-.04l7.2-7.763a.48.48 0 0 0-.04-.706l-.778-.81z"
            fill="currentColor"
          />
        )}
      </svg>
    </span>
  );
}
