export type NotifyVariant = 'error' | 'success' | 'info' | 'warning';

export interface NotificationItem {
  id: string;
  message: string;
  variant: NotifyVariant;
}

type Listener = (items: NotificationItem[]) => void;

let items: NotificationItem[] = [];
const listeners = new Set<Listener>();

function emit() {
  const snapshot = [...items];
  listeners.forEach((listener) => listener(snapshot));
}

function add(message: string, variant: NotifyVariant, durationMs: number) {
  const id = crypto.randomUUID();
  items = [...items, { id, message, variant }];
  emit();
  window.setTimeout(() => dismiss(id), durationMs);
}

export function dismiss(id: string) {
  items = items.filter((item) => item.id !== id);
  emit();
}

export const notify = {
  error: (message: string) => add(message, 'error', 10_000),
  success: (message: string) => add(message, 'success', 4_000),
  info: (message: string) => add(message, 'info', 5_000),
  warning: (message: string) => add(message, 'warning', 7_000),
};

export function subscribeNotifications(listener: Listener) {
  listeners.add(listener);
  listener([...items]);
  return () => {
    listeners.delete(listener);
  };
}
