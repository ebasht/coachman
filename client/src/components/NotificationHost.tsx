import { useEffect, useState } from 'react';
import { dismiss, subscribeNotifications, type NotificationItem } from '../lib/notify';

const ICONS: Record<NotificationItem['variant'], string> = {
  error: '✕',
  success: '✓',
  info: 'ℹ',
  warning: '!',
};

export function NotificationHost() {
  const [items, setItems] = useState<NotificationItem[]>([]);

  useEffect(() => subscribeNotifications(setItems), []);

  if (!items.length) return null;

  return (
    <div className="notification-host" aria-live="polite" aria-relevant="additions">
      {items.map((item) => (
        <div key={item.id} className={`notification notification-${item.variant}`} role="alert">
          <span className="notification-icon" aria-hidden>
            {ICONS[item.variant]}
          </span>
          <p className="notification-text">{item.message}</p>
          <button
            type="button"
            className="notification-close"
            onClick={() => dismiss(item.id)}
            aria-label="Закрыть"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
