import { useEffect, useRef, useCallback, useState } from 'react';
import { getAuthToken, onAuthTokenChange } from '../lib/api';
import { isStandalonePWA } from '../lib/pwa';
import { isNativeAndroid } from '../lib/native-calls';
import {
  reconnectDelayMs,
  shouldCloseSocketImmediately,
  shouldPauseWhenHidden,
  websocketURL,
  WS_HIDDEN_GRACE_MS,
} from '../lib/ws-policy';
import type { CallSignal } from '../lib/call-types';

type MessageHandler = (payload: unknown) => void;
type CallHandler = (payload: CallSignal) => void;

export type WsConnectionState = 'connected' | 'connecting' | 'disconnected';

const WS_CONNECT_TIMEOUT_MS = 12_000;

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
  const hideGraceTimerRef = useRef<number | undefined>(undefined);
  const authTimerRef = useRef<number | undefined>(undefined);
  const reconnectAttemptRef = useRef(0);
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
  const pauseWhenHiddenRef = useRef(shouldPauseWhenHidden(navigator.userAgent, isStandalonePWA()));
  const keepAliveRef = useRef(keepAlive);
  const keepAliveExternalRef = useRef(keepAliveRefExternal);
  const connectRef = useRef<() => void>(() => {});
  const [connectionState, setConnectionState] = useState<WsConnectionState>('disconnected');
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

  const clearHideGrace = useCallback(() => {
    if (hideGraceTimerRef.current !== undefined) {
      window.clearTimeout(hideGraceTimerRef.current);
      hideGraceTimerRef.current = undefined;
    }
  }, []);

  const clearAuthTimer = useCallback(() => {
    if (authTimerRef.current !== undefined) {
      window.clearTimeout(authTimerRef.current);
      authTimerRef.current = undefined;
    }
  }, []);

  const armConnectionTimer = useCallback((ws: WebSocket) => {
    clearAuthTimer();
    authTimerRef.current = window.setTimeout(() => {
      // WebKit can leave a dead socket in CONNECTING forever after a PWA
      // resume. Closing both CONNECTING and unauthenticated OPEN sockets lets
      // the normal backoff create a fresh connection.
      if (wsRef.current !== ws) return;
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }, WS_CONNECT_TIMEOUT_MS);
  }, [clearAuthTimer]);

  const closeSocket = useCallback(() => {
    clearReconnect();
    clearHideGrace();
    clearAuthTimer();
    wsRef.current?.close();
    wsRef.current = null;
    setConnectionState('disconnected');
  }, [clearAuthTimer, clearHideGrace, clearReconnect]);

  const connect = useCallback(() => {
    const token = getAuthToken();
    if (!enabled || !token) {
      setConnectionState('disconnected');
      return;
    }
    if (pauseWhenHiddenRef.current && document.hidden && !shouldKeepAlive()) return;
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
      return;
    }

    clearReconnect();
    setConnectionState('connecting');

    const ws = new WebSocket(websocketURL(window.location));
    wsRef.current = ws;
    armConnectionTimer(ws);

    ws.onopen = () => {
      reconnectAttemptRef.current = 0;
      // TCP/WebSocket open is not enough: the server only registers this socket
      // after validating the JWT. Wait for auth_ok before advertising live state
      // or starting reconnect catch-up.
      setConnectionState('connecting');
      ws.send(JSON.stringify({ type: 'auth', token }));
      armConnectionTimer(ws);
    };

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data as string);
        if (data.type === 'auth_ok') {
          clearAuthTimer();
          setConnectionState('connected');
          try {
            reconnectRef.current?.();
          } catch {
            // ignore reconnect hook faults
          }
          return;
        }
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
      clearAuthTimer();
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      setConnectionState('disconnected');
      if (!getAuthToken()) return;
      // Keep trying during an active call even if the WebView is covered.
      if (pauseWhenHiddenRef.current && document.hidden && !shouldKeepAlive()) return;
      clearReconnect();
      setConnectionState('connecting');
      reconnectAttemptRef.current += 1;
      const delay = reconnectDelayMs(reconnectAttemptRef.current);
      reconnectTimerRef.current = window.setTimeout(() => connectRef.current(), delay);
    };
  }, [armConnectionTimer, clearAuthTimer, clearReconnect, enabled]);

  connectRef.current = connect;

  useEffect(() => {
    if (!enabled) {
      setConnectionState('disconnected');
      clearReconnect();
      wsRef.current?.close();
      wsRef.current = null;
      return;
    }
    connect();

    const onVisibility = () => {
      if (!pauseWhenHiddenRef.current) return;
      if (document.hidden) {
        // Video calls need continuous signaling; closing WS drops ICE mid-setup on Android.
        if (shouldKeepAlive()) {
          clearHideGrace();
          return;
        }
        if (shouldCloseSocketImmediately(isNativeAndroid(), false)) {
          closeSocket();
          return;
        }
        clearHideGrace();
        hideGraceTimerRef.current = window.setTimeout(() => {
          if (document.hidden && !shouldKeepAlive()) closeSocket();
        }, WS_HIDDEN_GRACE_MS);
      } else {
        clearHideGrace();
        reconnectAttemptRef.current = 0;
        setConnectionState('connecting');
        connect();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      closeSocket();
    };
  }, [clearReconnect, clearHideGrace, closeSocket, connect, enabled]);

  // Incoming native call UI can set keepAlive while document.hidden — open WS then.
  useEffect(() => {
    if (!enabled || !keepAlive) return;
    connect();
  }, [enabled, keepAlive, connect]);

  // Reconnect when auth token changes (e.g. after async re-auth with fresh JWT).
  useEffect(() => {
    if (!enabled) return;
    return onAuthTokenChange((token) => {
      if (!token) return;
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        // A token may refresh while the previous socket is open but was never
        // authenticated. Re-authenticate in place; the hub supports it.
        setConnectionState('connecting');
        ws.send(JSON.stringify({ type: 'auth', token }));
        armConnectionTimer(ws);
        return;
      }
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        clearReconnect();
        reconnectAttemptRef.current = 0;
        setConnectionState('connecting');
        connect();
      }
    });
  }, [enabled, connect, clearReconnect, armConnectionTimer]);

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

  return { notify, sendTyping, sendCall, connectionState };
}
