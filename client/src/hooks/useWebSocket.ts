import { useEffect, useRef, useCallback } from 'react';
import { getAuthToken } from '../lib/api';
import { isStandalonePWA } from '../lib/pwa';

type MessageHandler = (payload: unknown) => void;

function shouldPauseWhenHidden(): boolean {
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
) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const handlerRef = useRef(onMessage);
  const membersRef = useRef(onMembersChanged);
  const readRef = useRef(onRead);
  const presenceRef = useRef(onPresence);
  const typingRef = useRef(onTyping);
  const deletedRef = useRef(onMessageDeleted);
  const pauseWhenHiddenRef = useRef(shouldPauseWhenHidden());
  handlerRef.current = onMessage;
  membersRef.current = onMembersChanged;
  readRef.current = onRead;
  presenceRef.current = onPresence;
  typingRef.current = onTyping;
  deletedRef.current = onMessageDeleted;

  const clearReconnect = useCallback(() => {
    if (reconnectTimerRef.current !== undefined) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = undefined;
    }
  }, []);

  const connect = useCallback(() => {
    const token = getAuthToken();
    if (!enabled || !token) return;
    if (pauseWhenHiddenRef.current && document.hidden) return;
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
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      if (!getAuthToken()) return;
      if (pauseWhenHiddenRef.current && document.hidden) return;
      clearReconnect();
      reconnectTimerRef.current = window.setTimeout(connect, 3000);
    };
  }, [clearReconnect, enabled]);

  useEffect(() => {
    connect();

    const onVisibility = () => {
      if (!pauseWhenHiddenRef.current) return;
      if (document.hidden) {
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

  return { notify, sendTyping };
}
