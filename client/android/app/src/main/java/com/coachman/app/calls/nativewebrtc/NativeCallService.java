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
 *
 * While ringing this is a normal (non-foreground) service started from
 * {@link NativeCallActivity}. Camera|microphone FGS starts only after Answer —
 * so it never competes with {@link IncomingCallRingService}'s shortService.
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
    /** User tapped Accept (or notification autoAccept) — may arrive before WS/PC. */
    private final AtomicBoolean acceptRequested = new AtomicBoolean(false);
    /** Accept signal + active offer already sent once. */
    private final AtomicBoolean acceptCompleted = new AtomicBoolean(false);
    private final AtomicBoolean bootstrapped = new AtomicBoolean(false);
    private final android.os.Handler mainHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private Runnable acceptPreviewTimeout;

    private NativeCallSignalingClient signaling;
    private NativePeerConnectionClient peer;
    private String callId = "";
    private String chatId = "";
    private String fromUserId = "";
    private String title = "";
    private String body = "";
    private boolean accepted;
    private boolean mediaForeground;
    private boolean pendingReject;
    private boolean signalingReady;
    private boolean previewAnswered;
    private NativeCallSessionStore.State state = NativeCallSessionStore.State.RINGING;

    /**
     * Start from a visible Activity (not from FCM). Uses startService — no FGS yet.
     */
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
        context.startService(i);
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
        applyExtras(intent);

        String action = intent.getAction();
        if (ACTION_ACCEPT.equals(action)) {
            ensureSession();
            acceptCall();
            return START_STICKY;
        }
        if (ACTION_REJECT.equals(action)) {
            ensureSession();
            rejectCall();
            return START_NOT_STICKY;
        }
        if (ACTION_HANGUP.equals(action)) {
            hangup(true);
            return START_NOT_STICKY;
        }

        if (callId.isEmpty() || chatId.isEmpty()) {
            stopSelf();
            return START_NOT_STICKY;
        }

        NativeCallLogger.i("NATIVE_SERVICE_STARTED", callId);
        ensureSession();
        return START_STICKY;
    }

    private void applyExtras(Intent intent) {
        if (intent == null) return;
        String id = safe(intent.getStringExtra(EXTRA_CALL_ID));
        if (!id.isEmpty()) callId = id;
        String chat = safe(intent.getStringExtra(EXTRA_CHAT_ID));
        if (!chat.isEmpty()) chatId = chat;
        fromUserId = safe(intent.getStringExtra(EXTRA_FROM_USER_ID));
        String t = safe(intent.getStringExtra(EXTRA_TITLE));
        String b = safe(intent.getStringExtra(EXTRA_BODY));
        if (!t.isEmpty()) title = t;
        if (!b.isEmpty()) body = b;
        if (title.isEmpty()) title = "Входящий видеозвонок";
        if (body.isEmpty()) body = "Собеседник";
    }

    private void ensureSession() {
        if (callId.isEmpty() || chatId.isEmpty()) return;
        NativeCallSessionStore.put(
            this, callId, chatId, fromUserId, body, "",
            NativeCallSessionStore.State.RINGING, false, 1
        );
        if (bootstrapped.compareAndSet(false, true)) {
            bootstrap();
        }
    }

    private void upgradeToMediaForeground() {
        try {
            CoachmanCallsPlugin.ensureIncomingChannelStatic(this);
            Intent open = NativeCallActivity.createIntent(
                this, callId, chatId, fromUserId, title, body, true
            );
            PendingIntent pi = PendingIntent.getActivity(
                this, callId.hashCode(), open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            Notification n = new NotificationCompat.Builder(this, CoachmanCallsPlugin.INCOMING_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_coachman)
                .setContentTitle(title.isEmpty() ? "Видеозвонок" : title)
                .setContentText("Идёт разговор")
                .setContentIntent(pi)
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
            mediaForeground = true;
        } catch (Exception e) {
            NativeCallLogger.e("NATIVE_FGS_MEDIA_UPGRADE_FAILED", callId, e);
        }
    }

    private void bootstrap() {
        NativeCallAuthStore.Creds creds = NativeCallAuthStore.peek(this);
        if (creds == null) {
            setState(NativeCallSessionStore.State.FAILED);
            emitError("Нет сессии для звонка");
            if (pendingReject) {
                pendingReject = false;
                cleanup(false);
            }
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
                if (!isOffer && "preview".equals(stage)) {
                    previewAnswered = true;
                    NativeCallLogger.i("NATIVE_PREVIEW_ANSWER_SENT", callId);
                    // Never renegotiate from inside WebRTC SdpObserver — aborts signaling thread.
                    mainHandler.postDelayed(NativeCallService.this::maybeCompleteAccept, 50);
                }
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
                signalingReady = true;
                if (pendingReject) {
                    pendingReject = false;
                    sendRejectAndCleanup();
                    return;
                }
                setState(NativeCallSessionStore.State.PREVIEW_CONNECTING);
                peer.ensurePreviewPeerConnection(creds.baseUrl, creds.accessToken);
                mainHandler.postDelayed(NativeCallService.this::sendReady, 400);
                maybeCompleteAccept();
            }

            @Override
            public void onDisconnected() {
                signalingReady = false;
            }

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
        if (!signalingReady || peer == null || !peer.hasPeerConnection()) {
            readySent.set(false);
            mainHandler.postDelayed(this::sendReady, 300);
            return;
        }
        sendPayload(p -> {
            try {
                p.put("action", "ready");
            } catch (Exception ignored) {
            }
        });
        NativeCallLogger.i("NATIVE_READY_SENT", callId);
        maybeCompleteAccept();
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
                if (acceptCompleted.get()) {
                    NativeCallLogger.i("NATIVE_PREVIEW_OFFER_SKIP_AFTER_ACCEPT", callId);
                    break;
                }
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
        if (!acceptRequested.compareAndSet(false, true)) {
            NativeCallLogger.i("NATIVE_ANSWER_DUP", callId);
            maybeCompleteAccept();
            return;
        }
        accepted = true;
        setState(NativeCallSessionStore.State.ANSWERING);
        NativeCallLogger.i("NATIVE_ANSWER_CLICKED", callId);
        IncomingCallRingService.dismissNow(this, callId);
        upgradeToMediaForeground();
        NativeCallSessionStore.updateState(this, NativeCallSessionStore.State.ACTIVE_CONNECTING, true);
        setState(NativeCallSessionStore.State.ACTIVE_CONNECTING);
        // Accept can arrive from notification before WS/PC exist — defer until ready.
        scheduleAcceptPreviewTimeout();
        maybeCompleteAccept();
    }

    private void scheduleAcceptPreviewTimeout() {
        if (acceptPreviewTimeout != null) {
            mainHandler.removeCallbacks(acceptPreviewTimeout);
        }
        acceptPreviewTimeout = () -> {
            if (acceptCompleted.get()) return;
            if (peer != null && peer.isSdpBusy()) {
                NativeCallLogger.i("NATIVE_ACCEPT_TIMEOUT_BUSY_RETRY", callId);
                mainHandler.postDelayed(acceptPreviewTimeout, 500);
                return;
            }
            NativeCallLogger.i("NATIVE_ACCEPT_PREVIEW_TIMEOUT", callId);
            previewAnswered = true; // proceed without preview
            maybeCompleteAccept();
        };
        mainHandler.postDelayed(acceptPreviewTimeout, 8_000);
    }

    /**
     * Send accept + active offer only when signaling is up, preview PC exists,
     * and preview answer was sent (or timed out). Fixes autoAccept-before-WS race.
     */
    private void maybeCompleteAccept() {
        if (!acceptRequested.get() || acceptCompleted.get()) return;
        if (!signalingReady || signaling == null) {
            NativeCallLogger.i("NATIVE_ACCEPT_WAIT_SIGNALING", callId);
            return;
        }
        if (peer == null || !peer.hasPeerConnection()) {
            NativeCallLogger.i("NATIVE_ACCEPT_WAIT_PC", callId);
            return;
        }
        if (!previewAnswered) {
            NativeCallLogger.i("NATIVE_ACCEPT_WAIT_PREVIEW", callId);
            return;
        }
        if (peer.isSdpBusy() || !peer.isSignalingStable()) {
            NativeCallLogger.i("NATIVE_ACCEPT_WAIT_STABLE", callId);
            mainHandler.postDelayed(this::maybeCompleteAccept, 100);
            return;
        }
        if (!acceptCompleted.compareAndSet(false, true)) return;
        if (acceptPreviewTimeout != null) {
            mainHandler.removeCallbacks(acceptPreviewTimeout);
            acceptPreviewTimeout = null;
        }
        sendPayload(p -> {
            try {
                p.put("action", "accept");
            } catch (Exception ignored) {
            }
        });
        NativeCallLogger.i("NATIVE_ACCEPT_SENT", callId);
        // Run off any WebRTC callback stack.
        mainHandler.post(() -> {
            if (peer == null) return;
            peer.startLocalMediaAndCreateActiveOffer(true);
            VideoTrack local = peer.camera().getTrack();
            if (local != null) {
                for (UiListener l : listeners) l.onLocalTrack(local);
            }
            NativeCallLogger.i("NATIVE_PERMISSION_GRANTED", callId);
        });
    }

    public void rejectCall() {
        NativeCallLogger.i("NATIVE_CALL_ENDED", callId, "reject");
        IncomingCallRingService.dismissNow(this, callId);
        if (signaling == null) {
            pendingReject = true;
            if (!bootstrapped.get()) ensureSession();
            // If auth missing, bootstrap fails immediately — still end locally.
            if (state == NativeCallSessionStore.State.FAILED) {
                cleanup(false);
            }
            return;
        }
        sendRejectAndCleanup();
    }

    private void sendRejectAndCleanup() {
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
        if (acceptPreviewTimeout != null) {
            mainHandler.removeCallbacks(acceptPreviewTimeout);
            acceptPreviewTimeout = null;
        }
        setState(NativeCallSessionStore.State.ENDING);
        IncomingCallRingService.dismissNow(this, callId);
        if (signaling != null) signaling.disconnect();
        if (peer != null) peer.dispose();
        NativeCallSessionStore.clearIfCall(this, callId);
        NativeCallLogger.i("NATIVE_CALL_ENDED", callId, "needsUnlock=" + needsUnlock);
        for (UiListener l : listeners) l.onEnded(needsUnlock);
        setState(NativeCallSessionStore.State.ENDED);
        if (mediaForeground) {
            try {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } catch (Exception ignored) {
            }
            mediaForeground = false;
        }
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
