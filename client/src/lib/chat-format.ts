import type { StoredMessage } from './storage';

export function chatInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return (name.trim()[0] ?? '?').toUpperCase();
}

export function messagePreview(msg: Pick<StoredMessage, 'type' | 'text'>): string {
  if (msg.type === 'image') return 'Фото';
  const text = msg.text.trim();
  if (!text || text.startsWith('[')) return 'Сообщение';
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

export function formatChatListTime(ts: number): string {
  const now = new Date();
  const date = new Date(ts);
  const today = startOfDay(now.getTime());
  const yesterday = today - 86_400_000;
  const day = startOfDay(ts);

  if (day === today) {
    return date.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  }
  if (day === yesterday) return 'Вчера';
  if (today - day < 7 * 86_400_000) {
    return date.toLocaleDateString('ru', { weekday: 'short' });
  }
  return date.toLocaleDateString('ru', { day: 'numeric', month: 'short' });
}

export function formatDateDivider(ts: number): string {
  const now = new Date();
  const today = startOfDay(now.getTime());
  const yesterday = today - 86_400_000;
  const day = startOfDay(ts);

  if (day === today) return 'Сегодня';
  if (day === yesterday) return 'Вчера';
  return new Date(ts).toLocaleDateString('ru', {
    day: 'numeric',
    month: 'long',
    year: now.getFullYear() !== new Date(ts).getFullYear() ? 'numeric' : undefined,
  });
}

export function formatMessageTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}

const GROUP_GAP_MS = 5 * 60 * 1000;

export function isFirstInMessageGroup(
  messages: StoredMessage[],
  index: number,
): boolean {
  const current = messages[index];
  const prev = messages[index - 1];
  if (!prev) return true;
  if (!isSameDay(prev.createdAt, current.createdAt)) return true;
  if (prev.senderId !== current.senderId) return true;
  return current.createdAt - prev.createdAt > GROUP_GAP_MS;
}

export function isLastInMessageGroup(
  messages: StoredMessage[],
  index: number,
): boolean {
  const current = messages[index];
  const next = messages[index + 1];
  if (!next) return true;
  if (!isSameDay(current.createdAt, next.createdAt)) return true;
  if (next.senderId !== current.senderId) return true;
  return next.createdAt - current.createdAt > GROUP_GAP_MS;
}
