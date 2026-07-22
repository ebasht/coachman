package com.coachman.app.calls.nativewebrtc;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Binder;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.coachman.app.R;
import com.coachman.app.calls.CoachmanCallsPlugin;
import com.coachman.app.calls.IncomingCallRingService;

import org.json.JSONObject;
import org.webrtc.IceCandidate;
import org.webrtc.PeerConnection;
import org.webrtc.SessionDescription;
import org.webrtc.VideoTrack;

import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Owns native call session, signaling, and PeerConnection across Activity recreation.
 */
public class NativeCallService extends Service {
    public static final String EXTRA_CALL_ID = "callId";
    public static final String EXTRA_CHAT_ID = "chatId";
    public static final String EXTRA_FROM_USER_ID = "fromUserId";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_BODY = "body";
    public static final String ACTION_ACCEPT = "com.coachman.app.NATIVE_ACCEPT";
    public static final String ACTION_REJECT = "com.coachman.app.NATIVE_REJECT";
    public static final String ACTION_HANGUP = "com.coachman.app.NATIVE_HANGUP";

    public interface UiListener {
        void onState(NativeCallSessionStore.State state);
        void onRemoteTrack(VideoTrack track);
        void onLocalTrack(VideoTrack track);
        void onError(String message);
        void onEnded(boolean needsUnlock);
    }

    public class LocalBinder extends Binder {
        public NativeCallService getService() {
            return NativeCallService.this;
        }
    }

    private final IBinder binder = new LocalBinder();
    private final CopyOnWriteArrayList<UiListener> listeners = new CopyOnWriteArrayList<>();
    private final AtomicBoolean readySent = new AtomicBoolean(false);
    private final AtomicBoolean answering = new AtomicBoolean(false);

    private NativeCallSignalingClient signaling;
    private NativePeerConnectionClient peer;
    private String callId = "";
    private String chatId = "";
    private String fromUserId = "";
    private String title = "";
    private String body = "";
    private boolean accepted;
    private NativeCallSessionStore.State state = NativeCallSessionStore.State.RINGING;

    public static void start(
        Context context,
        String callId,
        String chatId,
        String fromUserId,
        String title,
        String body
    ) {
        Intent i = new Intent(context, NativeCallService.class);
        i.putExtra(EXTRA_CALL_ID, callId);
        i.putExtra(EXTRA_CHAT_ID, chatId);
        i.putExtra(EXTRA_FROM_USER_ID, fromUserId);
        i.putExtra(EXTRA_TITLE, title);
        i.putExtra(EXTRA_BODY, body);
        ContextCompat.startForegroundService(context, i);
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, NativeCallService.class));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }

    public void addListener(UiListener l) {
        listeners.add(l);
        l.onState(state);
    }

    public void removeListener(UiListener l) {
        listeners.remove(l);
    }

    public NativePeerConnectionClient getPeer() {
        return peer;
    }

    public boolean isAccepted() {
        return accepted;
    }

    public String getCallId() {
        return callId;
    }

    public String getCallerName() {
        return body;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        String action = intent.getAction();
        if (ACTION_ACCEPT.equals(action)) {
            acceptCall();
            return START_STICKY;
        }
        if (ACTION_REJECT.equals(action)) {
            rejectCall();
            return START_NOT_STICKY;
        }
        if (ACTION_HANGUP.equals(action)) {
            hangup(true);
            return START_NOT_STICKY;
        }

        callId = safe(intent.getStringExtra(EXTRA_CALL_ID));
        chatId = safe(intent.getStringExtra(EXTRA_CHAT_ID));
        fromUserId = safe(intent.getStringExtra(EXTRA_FROM_USER_ID));
        title = safe(intent.getStringExtra(EXTRA_TITLE));
        body = safe(intent.getStringExtra(EXTRA_BODY));
        if (title.isEmpty()) title = "Входящий видеозвонок";
        if (body.isEmpty()) body = "Собеседник";
        if (callId.isEmpty() || chatId.isEmpty()) {
            stopSelf();
            return START_NOT_STICKY;
        }

        NativeCallLogger.i("NATIVE_SERVICE_STARTED", callId);
        NativeCallSessionStore.put(
            this, callId, chatId, fromUserId, body, "",
            NativeCallSessionStore.State.RINGING, false, 1
        );
        startAsForeground();
        bootstrap();
        return START_STICKY;
    }

    private void startAsForeground() {
        CoachmanCallsPlugin.ensureIncomingChannelStatic(this);
        Intent open = NativeCallActivity.createIntent(this, callId, chatId, fromUserId, title, body, true);
        PendingIntent pi = PendingIntent.getActivity(
            this, callId.hashCode(), open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        Notification n = new NotificationCompat.Builder(this, CoachmanCallsPlugin.INCOMING_CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(pi)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .build();
        try {
            // While ringing: shortService only (safe from FCM/cold start). Camera|mic after Answer.
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(43001, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE);
            } else if (Build.VERSION.SDK_INT >= 29) {
                startForeground(43001, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE);
            } else {
                startForeground(43001, n);
            }
        } catch (Exception e) {
            NativeCallLogger.e("NATIVE_FGS_START_FAILED", callId, e);
            try {
                startForeground(43001, n);
            } catch (Exception e2) {
                NativeCallLogger.e("NATIVE_FGS_FALLBACK_FAILED", callId, e2);
            }
        }
    }

    private void upgradeToMediaForeground() {
        try {
            CoachmanCallsPlugin.ensureIncomingChannelStatic(this);
            Notification n = new NotificationCompat.Builder(this, CoachmanCallsPlugin.INCOMING_CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title.isEmpty() ? "Видеозвонок" : title)
                .setContentText("Идёт разговор")
                .setOngoing(true)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
            if (Build.VERSION.SDK_INT >= 29) {
                int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
                    | ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                startForeground(43001, n, type);
            } else {
                startForeground(43001, n);
            }
        } catch (Exception e) {
            NativeCallLogger.e("NATIVE_FGS_MEDIA_UPGRADE_FAILED", callId, e);
        }
    }

    private void bootstrap() {
        NativeCallAuthStore.Creds creds = NativeCallAuthStore.peek(this);
        if (creds == null) {
            setState(NativeCallSessionStore.State.FAILED);
            emitError("Нет сессии для звонка");
            return;
        }
        peer = new NativePeerConnectionClient(this);
        peer.prepareFactory(new NativePeerConnectionClient.Callbacks() {
            @Override
            public void onRemoteVideoTrack(VideoTrack track) {
                setState(NativeCallSessionStore.State.PREVIEW_VISIBLE);
                for (UiListener l : listeners) l.onRemoteTrack(track);
            }

            @Override
            public void onIceCandidate(IceCandidate candidate, String stage) {
                sendIce(candidate, stage);
            }

            @Override
            public void onLocalSdp(SessionDescription sdp, String stage) {
                if (sdp == null) return;
                boolean isOffer = sdp.type == SessionDescription.Type.OFFER;
                sendPayload(payload -> {
                    payload.put("action", isOffer ? "offer" : "answer");
                    payload.put("stage", stage);
                    payload.put("sdp", sdp.description);
                });
            }

            @Override
            public void onConnectionChange(PeerConnection.PeerConnectionState state) {
                if (state == PeerConnection.PeerConnectionState.CONNECTED && accepted) {
                    setState(NativeCallSessionStore.State.ACTIVE);
                    NativeCallLogger.i("NATIVE_CALL_ACTIVE", callId);
                }
            }

            @Override
            public void onError(String message) {
                emitError(message);
            }
        });

        signaling = new NativeCallSignalingClient();
        signaling.connect(creds.baseUrl, creds.accessToken, callId, new NativeCallSignalingClient.Listener() {
            @Override
            public void onConnected() {
                setState(NativeCallSessionStore.State.PREVIEW_CONNECTING);
                peer.ensurePreviewPeerConnection(creds.baseUrl, creds.accessToken);
                // slight delay so PC exists
                getMainLooper();
                new android.os.Handler(getMainLooper()).postDelayed(NativeCallService.this::sendReady, 400);
            }

            @Override
            public void onDisconnected() {}

            @Override
            public void onCallSignal(JSONObject payload) {
                handleSignal(payload);
            }
        });
    }

    private void sendReady() {
        if (!readySent.compareAndSet(false, true)) {
            NativeCallLogger.i("NATIVE_READY_SKIP_DUP", callId);
            return;
        }
        if (peer != null && !peer.hasPeerConnection()) {
            readySent.set(false);
            new android.os.Handler(getMainLooper()).postDelayed(this::sendReady, 300);
            return;
        }
        sendPayload(p -> {
            try {
                p.put("action", "ready");
            } catch (Exception ignored) {
            }
        });
        NativeCallLogger.i("NATIVE_READY_SENT", callId);
    }

    private void handleSignal(JSONObject payload) {
        String action = payload.optString("action", "");
        String transport = payload.optString("transport", "");
        if (!"native-android".equals(transport) && !"ready".equals(action)) {
            // Still accept native-tagged or offer/answer for this callId.
        }
        String stage = payload.optString("stage", "");
        switch (action) {
            case "offer":
                NativeCallLogger.i("NATIVE_PREVIEW_OFFER_RECEIVED", callId, "stage=" + stage);
                if (peer != null) {
                    peer.setRemoteOffer(payload.optString("sdp", null), stage.isEmpty() ? "preview" : stage);
                }
                break;
            case "answer":
                if ("active".equals(stage) && peer != null) {
                    peer.setRemoteAnswer(payload.optString("sdp", null));
                    setState(NativeCallSessionStore.State.ACTIVE);
                }
                break;
            case "ice":
                if (peer != null) {
                    JSONObject c = payload.optJSONObject("candidate");
                    if (c != null) {
                        peer.addRemoteIce(new IceCandidate(
                            c.optString("sdpMid"),
                            c.optInt("sdpMLineIndex"),
                            c.optString("candidate")
                        ));
                    }
                }
                break;
            case "hangup":
            case "reject":
                endFromRemote();
                break;
            default:
                break;
        }
    }

    public void acceptCall() {
        if (!answering.compareAndSet(false, true)) return;
        accepted = true;
        setState(NativeCallSessionStore.State.ANSWERING);
        NativeCallLogger.i("NATIVE_ANSWER_CLICKED", callId);
        IncomingCallRingService.dismissNow(this, callId);
        upgradeToMediaForeground();
        sendPayload(p -> {
            try {
                p.put("action", "accept");
            } catch (Exception ignored) {
            }
        });
        NativeCallSessionStore.updateState(this, NativeCallSessionStore.State.ACTIVE_CONNECTING, true);
        setState(NativeCallSessionStore.State.ACTIVE_CONNECTING);
        if (peer != null) {
            peer.startLocalMediaAndCreateActiveOffer(true);
            VideoTrack local = peer.camera().getTrack();
            if (local != null) {
                for (UiListener l : listeners) l.onLocalTrack(local);
            }
        }
        NativeCallLogger.i("NATIVE_PERMISSION_GRANTED", callId);
    }

    public void rejectCall() {
        NativeCallLogger.i("NATIVE_CALL_ENDED", callId, "reject");
        sendPayload(p -> {
            try {
                p.put("action", "reject");
            } catch (Exception ignored) {
            }
        });
        cleanup(false);
    }

    public void hangup(boolean local) {
        if (local) {
            sendPayload(p -> {
                try {
                    p.put("action", "hangup");
                } catch (Exception ignored) {
                }
            });
        }
        cleanup(accepted);
    }

    private void endFromRemote() {
        cleanup(accepted);
    }

    private void cleanup(boolean needsUnlock) {
        setState(NativeCallSessionStore.State.ENDING);
        IncomingCallRingService.dismissNow(this, callId);
        if (signaling != null) signaling.disconnect();
        if (peer != null) peer.dispose();
        NativeCallSessionStore.clearIfCall(this, callId);
        NativeCallLogger.i("NATIVE_CALL_ENDED", callId, "needsUnlock=" + needsUnlock);
        for (UiListener l : listeners) l.onEnded(needsUnlock);
        setState(NativeCallSessionStore.State.ENDED);
        stopForeground(true);
        stopSelf();
    }

    private interface PayloadWriter {
        void write(JSONObject p) throws Exception;
    }

    private void sendPayload(PayloadWriter writer) {
        if (signaling == null) return;
        try {
            JSONObject p = new JSONObject();
            p.put("chatId", chatId);
            p.put("callId", callId);
            p.put("transport", "native-android");
            writer.write(p);
            signaling.sendCall(p);
        } catch (Exception e) {
            NativeCallLogger.w("NATIVE_SEND_FAIL", callId, e);
        }
    }

    private void sendIce(IceCandidate candidate, String stage) {
        sendPayload(p -> {
            p.put("action", "ice");
            p.put("stage", stage);
            if (candidate != null) {
                JSONObject c = new JSONObject();
                c.put("sdpMid", candidate.sdpMid);
                c.put("sdpMLineIndex", candidate.sdpMLineIndex);
                c.put("candidate", candidate.sdp);
                p.put("candidate", c);
            } else {
                p.put("candidate", JSONObject.NULL);
            }
        });
    }

    private void setState(NativeCallSessionStore.State s) {
        state = s;
        NativeCallSessionStore.updateState(this, s, accepted);
        for (UiListener l : listeners) l.onState(s);
    }

    private void emitError(String msg) {
        for (UiListener l : listeners) l.onError(msg);
    }

    private static String safe(String v) {
        return v == null ? "" : v;
    }

    @Override
    public void onDestroy() {
        if (signaling != null) signaling.disconnect();
        if (peer != null) peer.dispose();
        super.onDestroy();
    }
}
