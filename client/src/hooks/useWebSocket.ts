import { useEffect, useRef, useCallback } from 'react';
import { getAuthToken } from '../lib/api';
import { isStandalonePWA } from '../lib/pwa';
import type { CallSignal } from '../lib/call-types';

type MessageHandler = (payload: unknown) => void;
type CallHandler = (payload: CallSignal) => void;

function shouldPauseWhenHidden(): boolean {
  // Pause WS when backgrounded unless keepAlive. Capacitor Android must pause too:
  // IncomingCallActivity hosts its own WebView for lock-screen calls — if MainActivity
  // keeps reconnecting, it steals the hub seat and preview/active signaling dies.
  return isStandalonePWA() || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

export function useWebSocket(
  enabled: boolean,
  onMessage: MessageHandler,
  onMembersChanged?: MessageHandler,
  onRead?: MessageHandler,
  onPresence?: MessageHandler,
  onTyping?: MessageHandler,
  onMessageDeleted?: MessageHandler,
  onCall?: CallHandler,
  /** Keep socket open while backgrounded (needed for WebRTC signaling on Android PWA). */
  keepAlive = false,
  onChatCleared?: MessageHandler,
  onChatList?: MessageHandler,
  /** Fired after a successful socket open (reconnect / first connect). */
  onReconnect?: () => void,
  /**
   * Sync keep-alive checked on visibility change. Used when Accept sets connecting
   * before React re-renders — iOS mic/camera sheet can hide the page in that gap.
   */
  keepAliveRefExternal?: { current: boolean } | null,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const handlerRef = useRef(onMessage);
  const membersRef = useRef(onMembersChanged);
  const readRef = useRef(onRead);
  const presenceRef = useRef(onPresence);
  const typingRef = useRef(onTyping);
  const deletedRef = useRef(onMessageDeleted);
  const callRef = useRef(onCall);
  const clearedRef = useRef(onChatCleared);
  const listRef = useRef(onChatList);
  const reconnectRef = useRef(onReconnect);
  const pauseWhenHiddenRef = useRef(shouldPauseWhenHidden());
  const keepAliveRef = useRef(keepAlive);
  const keepAliveExternalRef = useRef(keepAliveRefExternal);
  const connectRef = useRef<() => void>(() => {});
  handlerRef.current = onMessage;
  membersRef.current = onMembersChanged;
  readRef.current = onRead;
  presenceRef.current = onPresence;
  typingRef.current = onTyping;
  deletedRef.current = onMessageDeleted;
  callRef.current = onCall;
  clearedRef.current = onChatCleared;
  listRef.current = onChatList;
  reconnectRef.current = onReconnect;
  keepAliveRef.current = keepAlive;
  keepAliveExternalRef.current = keepAliveRefExternal;

  const shouldKeepAlive = () =>
    keepAliveRef.current || !!keepAliveExternalRef.current?.current;

  const clearReconnect = useCallback(() => {
    if (reconnectTimerRef.current !== undefined) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = undefined;
    }
  }, []);

  const connect = useCallback(() => {
    const token = getAuthToken();
    if (!enabled || !token) return;
    if (pauseWhenHiddenRef.current && document.hidden && !shouldKeepAlive()) return;
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
      return;
    }

    clearReconnect();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = import.meta.env.DEV
      ? `${protocol}//127.0.0.1:3001`
      : `${protocol}//${window.location.host}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
      try {
        reconnectRef.current?.();
      } catch {
        // ignore reconnect hook faults
      }
    };

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data as string);
        if (data.type === 'message') handlerRef.current(data.payload);
        if (data.type === 'members_changed') membersRef.current?.(data.payload);
        if (data.type === 'read') readRef.current?.(data.payload);
        if (data.type === 'presence') presenceRef.current?.(data.payload);
        if (data.type === 'typing') typingRef.current?.(data.payload);
        if (data.type === 'message_deleted') deletedRef.current?.(data.payload);
        if (data.type === 'chat_cleared') clearedRef.current?.(data.payload);
        if (data.type === 'chat_list') listRef.current?.(data.payload);
        if (data.type === 'call') callRef.current?.(data.payload as CallSignal);
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      if (!getAuthToken()) return;
      // Keep trying during an active call even if the WebView is covered.
      if (pauseWhenHiddenRef.current && document.hidden && !shouldKeepAlive()) return;
      clearReconnect();
      reconnectTimerRef.current = window.setTimeout(() => connectRef.current(), 3000);
    };
  }, [clearReconnect, enabled]);

  connectRef.current = connect;

  useEffect(() => {
    connect();

    const onVisibility = () => {
      if (!pauseWhenHiddenRef.current) return;
      if (document.hidden) {
        // Video calls need continuous signaling; closing WS drops ICE mid-setup on Android.
        if (shouldKeepAlive()) return;
        clearReconnect();
        wsRef.current?.close();
        wsRef.current = null;
      } else {
        connect();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearReconnect();
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [clearReconnect, connect]);

  // Incoming native call UI can set keepAlive while document.hidden — open WS then.
  useEffect(() => {
    if (!enabled || !keepAlive) return;
    connect();
  }, [enabled, keepAlive, connect]);

  const notify = useCallback((payload: unknown) => {
    wsRef.current?.send(JSON.stringify({ type: 'message', payload }));
  }, []);

  const sendTyping = useCallback((chatId: string, isTyping: boolean) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'typing',
      payload: { chatId, isTyping },
    }));
  }, []);

  const sendCall = useCallback((payload: Omit<CallSignal, 'fromUserId'>) => {
    const raw = JSON.stringify({ type: 'call', payload });
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(raw);
      return;
    }
    // Ensure we are connecting — visibility alone may not reopen while covered by native UI.
    connectRef.current();
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (attempts % 4 === 1) connectRef.current();
      const sock = wsRef.current;
      if (sock?.readyState === WebSocket.OPEN) {
        sock.send(raw);
        window.clearInterval(timer);
        return;
      }
      if (attempts >= 40) {
        window.clearInterval(timer);
        console.warn('call signal not sent — websocket offline', payload.action);
      }
    }, 250);
  }, []);

  return { notify, sendTyping, sendCall };
}
