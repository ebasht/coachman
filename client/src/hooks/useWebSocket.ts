import { useEffect, useRef, useCallback } from 'react';
import { getAuthToken } from '../lib/api';

type MessageHandler = (payload: unknown) => void;

export function useWebSocket(
  enabled: boolean,
  onMessage: MessageHandler,
  onMembersChanged?: MessageHandler,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const handlerRef = useRef(onMessage);
  const membersRef = useRef(onMembersChanged);
  handlerRef.current = onMessage;
  membersRef.current = onMembersChanged;

  const connect = useCallback(() => {
    const token = getAuthToken();
    if (!enabled || !token) return;

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
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      if (getAuthToken()) {
        setTimeout(connect, 3000);
      }
    };
  }, [enabled]);

  useEffect(() => {
    connect();
    return () => wsRef.current?.close();
  }, [connect]);

  const notify = useCallback((payload: unknown) => {
    wsRef.current?.send(JSON.stringify({ type: 'message', payload }));
  }, []);

  return { notify };
}
