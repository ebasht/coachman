/** How long a hidden PWA/iOS tab may keep the socket before we close it. */
export const WS_HIDDEN_GRACE_MS = 45_000;

/**
 * Always use the page origin and the Vite/proxy WebSocket route.
 * Hard-coding 127.0.0.1 makes a dev build work only on the computer running
 * Vite; on a phone it points back at the phone and live delivery disappears.
 */
export function websocketURL(location: Pick<Location, 'protocol' | 'host'>): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws`;
}

/**
 * Pause the socket when backgrounded (PWA / mobile). Desktop browser tabs keep
 * the connection so switching away does not drop live delivery.
 */
export function shouldPauseWhenHidden(
  userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '',
  standalone = false,
): boolean {
  return standalone || /iPhone|iPad|iPod|Android/i.test(userAgent);
}

/**
 * Android Capacitor MainActivity must drop the hub seat immediately so
 * IncomingCallActivity can take signaling. Everyone else gets a grace period
 * so a quick app-switch does not miss the next message.
 */
export function shouldCloseSocketImmediately(nativeAndroid: boolean, keepAlive: boolean): boolean {
  if (keepAlive) return false;
  return nativeAndroid;
}

/** First reconnect is immediate; later attempts back off. */
export function reconnectDelayMs(attempt: number): number {
  if (attempt <= 1) return 0;
  return Math.min(8000, 400 * 2 ** Math.min(attempt - 2, 8));
}
