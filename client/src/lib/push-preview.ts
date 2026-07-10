/** Max notification body length (Unicode code points). Kept in sync with server. */
const MAX_PUSH_BODY = 120;

/** Truncate plaintext for push preview — not stored on the server, only used for the notification. */
export function truncatePushBody(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized) return '';
  const chars = Array.from(normalized);
  if (chars.length <= MAX_PUSH_BODY) return normalized;
  return chars.slice(0, MAX_PUSH_BODY - 1).join('') + '…';
}
