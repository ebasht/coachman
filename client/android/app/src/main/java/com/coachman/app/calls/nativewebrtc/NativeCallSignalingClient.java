package com.coachman.app.calls.nativewebrtc;

import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/** Native WebSocket call signaling — same envelope as React useWebSocket. */
public final class NativeCallSignalingClient {
    public interface Listener {
        void onConnected();
        void onDisconnected();
        void onCallSignal(JSONObject payload);
    }

    private final OkHttpClient client = new OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicBoolean intentionalClose = new AtomicBoolean(false);
    private final AtomicBoolean connectedNotified = new AtomicBoolean(false);

    private String baseUrl;
    private String token;
    private String callIdFilter;
    private Listener listener;
    private WebSocket socket;
    private int attempt;
    private Runnable authFallback;

    public void connect(String baseUrl, String token, String callIdFilter, Listener listener) {
        this.baseUrl = baseUrl;
        this.token = token;
        this.callIdFilter = callIdFilter;
        this.listener = listener;
        intentionalClose.set(false);
        connectedNotified.set(false);
        open();
    }

    public void disconnect() {
        intentionalClose.set(true);
        cancelAuthFallback();
        if (socket != null) {
            socket.close(1000, "bye");
            socket = null;
        }
    }

    public void sendCall(JSONObject payload) {
        if (socket == null) return;
        try {
            JSONObject msg = new JSONObject();
            msg.put("type", "call");
            msg.put("payload", payload);
            socket.send(msg.toString());
        } catch (Exception e) {
            NativeCallLogger.w("NATIVE_SIGNAL_SEND_FAIL", callIdFilter, e);
        }
    }

    private void notifyConnected(String reason) {
        if (!connectedNotified.compareAndSet(false, true)) return;
        cancelAuthFallback();
        NativeCallLogger.i("NATIVE_SIGNALING_CONNECTED", callIdFilter, reason);
        main.post(() -> {
            if (listener != null) listener.onConnected();
        });
    }

    private void cancelAuthFallback() {
        if (authFallback != null) {
            main.removeCallbacks(authFallback);
            authFallback = null;
        }
    }

    private void open() {
        if (baseUrl == null || token == null) return;
        connectedNotified.set(false);
        String ws = baseUrl.replaceFirst("^https:", "wss:").replaceFirst("^http:", "ws:");
        if (ws.endsWith("/")) ws = ws.substring(0, ws.length() - 1);
        Request req = new Request.Builder().url(ws).build();
        socket = client.newWebSocket(req, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                attempt = 0;
                try {
                    JSONObject auth = new JSONObject();
                    auth.put("type", "auth");
                    auth.put("token", token);
                    webSocket.send(auth.toString());
                } catch (Exception ignored) {
                }
                NativeCallLogger.i("NATIVE_SIGNALING_AUTH_SENT", callIdFilter);
                // Prefer auth_ok from server; fall back for older binaries.
                cancelAuthFallback();
                authFallback = () -> notifyConnected("auth_timeout");
                main.postDelayed(authFallback, 900);
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                try {
                    JSONObject msg = new JSONObject(text);
                    String type = msg.optString("type", "");
                    if ("auth_ok".equals(type)) {
                        notifyConnected("auth_ok");
                        return;
                    }
                    if (!"call".equals(type)) return;
                    JSONObject payload = msg.optJSONObject("payload");
                    if (payload == null) return;
                    String callId = payload.optString("callId", "");
                    if (callIdFilter != null && !callIdFilter.isEmpty() && !callIdFilter.equals(callId)) {
                        return;
                    }
                    main.post(() -> {
                        if (listener != null) listener.onCallSignal(payload);
                    });
                } catch (Exception e) {
                    NativeCallLogger.w("NATIVE_SIGNAL_PARSE", callIdFilter, e);
                }
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                cancelAuthFallback();
                main.post(() -> {
                    if (listener != null) listener.onDisconnected();
                });
                scheduleReconnect();
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                NativeCallLogger.w("NATIVE_SIGNAL_FAIL", callIdFilter, t);
                cancelAuthFallback();
                main.post(() -> {
                    if (listener != null) listener.onDisconnected();
                });
                scheduleReconnect();
            }
        });
    }

    private void scheduleReconnect() {
        if (intentionalClose.get()) return;
        attempt++;
        long delay = Math.min(10_000L, 500L * (1L << Math.min(attempt, 4)));
        main.postDelayed(this::open, delay);
    }
}
