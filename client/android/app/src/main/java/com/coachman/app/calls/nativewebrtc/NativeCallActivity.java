package com.coachman.app.calls.nativewebrtc;

import android.graphics.Outline;
import android.Manifest;
import android.app.KeyguardManager;
import android.app.PictureInPictureParams;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.util.Rational;
import android.view.View;
import android.view.ViewOutlineProvider;
import android.view.WindowManager;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.coachman.app.MainActivity;
import com.coachman.app.R;
import com.coachman.app.calls.IncomingCallRingService;

import org.webrtc.EglBase;
import org.webrtc.RendererCommon;
import org.webrtc.SurfaceViewRenderer;
import org.webrtc.VideoTrack;

/**
 * Lock-screen native WebRTC UI — FaceTime-style, no WebView / Capacitor.
 * Active calls can minimize to system Picture-in-Picture over chats.
 */
public class NativeCallActivity extends AppCompatActivity implements NativeCallService.UiListener {
    private static final int REQ_MEDIA = 4501;
    private static volatile boolean sInPip;

    private SurfaceViewRenderer remoteRenderer;
    private SurfaceViewRenderer localRenderer;
    private LinearLayout placeholder;
    private LinearLayout ringControls;
    private LinearLayout activeControls;
    private View liveTop;
    private View topScrim;
    private View bottomScrim;
    private TextView nameView;
    private TextView statusView;
    private TextView liveNameView;
    private TextView liveStatusView;
    private TextView avatarLetterView;
    private TextView labelReject;
    private TextView labelAccept;
    private TextView labelMute;
    private TextView labelCamera;
    private ImageButton btnMute;
    private ImageButton btnCamera;
    private ImageButton btnAccept;
    private ImageButton btnReject;
    private ImageButton btnMinimize;

    public static final String EXTRA_AUTO_ACCEPT = "autoAccept";
    public static final String EXTRA_AUTO_REJECT = "autoReject";

    private String callId = "";
    private String chatId = "";
    private String fromUserId = "";
    private String title = "";
    private String body = "";
    private boolean lockedAtStart = true;
    private boolean autoAccept;
    private boolean autoReject;

    private NativeCallService service;
    private boolean bound;
    private boolean renderersReady;
    private boolean remoteAttached;
    private boolean localAttached;
    private boolean finishing;
    private boolean pipEligible;
    private VideoTrack pendingRemote;
    private VideoTrack pendingLocal;
    private boolean muted;
    private boolean cameraOff;
    private final android.os.Handler uiHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private long callActiveSinceMs;
    private final Runnable durationTick = new Runnable() {
        @Override
        public void run() {
            if (callActiveSinceMs <= 0 || finishing) return;
            long elapsed = Math.max(0, (System.currentTimeMillis() - callActiveSinceMs) / 1000L);
            setStatusText(formatDuration(elapsed));
            uiHandler.postDelayed(this, 1000);
        }
    };

    private final ServiceConnection connection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            service = ((NativeCallService.LocalBinder) binder).getService();
            service.addListener(NativeCallActivity.this);
            bound = true;
            applyPendingCallAction();
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            bound = false;
            service = null;
        }
    };

    public static Intent createIntent(
        Context context,
        String callId,
        String chatId,
        String fromUserId,
        String title,
        String body,
        boolean lockedAtStart
    ) {
        return createIntent(
            context, callId, chatId, fromUserId, title, body, lockedAtStart, false, false
        );
    }

    public static Intent createIntent(
        Context context,
        String callId,
        String chatId,
        String fromUserId,
        String title,
        String body,
        boolean lockedAtStart,
        boolean autoAccept,
        boolean autoReject
    ) {
        Intent i = new Intent(context, NativeCallActivity.class);
        i.setFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
        );
        i.putExtra(NativeCallService.EXTRA_CALL_ID, callId);
        i.putExtra(NativeCallService.EXTRA_CHAT_ID, chatId);
        i.putExtra(NativeCallService.EXTRA_FROM_USER_ID, fromUserId);
        i.putExtra(NativeCallService.EXTRA_TITLE, title);
        i.putExtra(NativeCallService.EXTRA_BODY, body);
        i.putExtra("lockedAtStart", lockedAtStart);
        i.putExtra(EXTRA_AUTO_ACCEPT, autoAccept);
        i.putExtra(EXTRA_AUTO_REJECT, autoReject);
        return i;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
        super.onCreate(savedInstanceState);
        getWindow().addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_SECURE
        );
        setContentView(R.layout.activity_native_call);
        bindExtras(getIntent());
        NativeCallLogger.i("NATIVE_ACTIVITY_STARTED", callId);

        remoteRenderer = findViewById(R.id.native_remote_renderer);
        localRenderer = findViewById(R.id.native_local_renderer);
        placeholder = findViewById(R.id.native_call_placeholder);
        ringControls = findViewById(R.id.native_call_controls);
        activeControls = findViewById(R.id.native_active_controls);
        liveTop = findViewById(R.id.native_live_top);
        topScrim = findViewById(R.id.native_call_top_scrim);
        bottomScrim = findViewById(R.id.native_call_bottom_scrim);
        nameView = findViewById(R.id.native_call_name);
        statusView = findViewById(R.id.native_call_status);
        liveNameView = findViewById(R.id.native_live_name);
        liveStatusView = findViewById(R.id.native_live_status);
        avatarLetterView = findViewById(R.id.native_call_avatar_letter);
        labelReject = findViewById(R.id.native_label_reject);
        labelAccept = findViewById(R.id.native_label_accept);
        labelMute = findViewById(R.id.native_label_mute);
        labelCamera = findViewById(R.id.native_label_camera);
        btnMute = findViewById(R.id.native_btn_mute);
        btnCamera = findViewById(R.id.native_btn_camera);
        btnAccept = findViewById(R.id.native_btn_accept);
        btnReject = findViewById(R.id.native_btn_reject);
        btnMinimize = findViewById(R.id.native_btn_minimize);

        String displayName = body.isEmpty() ? "Собеседник" : body;
        nameView.setText(displayName);
        liveNameView.setText(displayName);
        avatarLetterView.setText(peerInitial(displayName));
        roundLocalPip();

        btnAccept.setOnClickListener(v -> onAcceptClicked());
        btnReject.setOnClickListener(v -> {
            if (service != null) service.rejectCall();
            else finishWithoutApp();
        });
        findViewById(R.id.native_btn_hangup).setOnClickListener(v -> {
            if (service != null) service.hangup(true);
        });
        btnMinimize.setOnClickListener(v -> minimizeToPip(true));
        btnMute.setOnClickListener(v -> {
            muted = !muted;
            if (service != null && service.getPeer() != null) {
                service.getPeer().audio().setMuted(muted);
            }
            refreshMuteUi();
        });
        btnCamera.setOnClickListener(v -> {
            cameraOff = !cameraOff;
            if (service != null && service.getPeer() != null) {
                service.getPeer().camera().setEnabled(!cameraOff);
            }
            refreshCameraUi();
        });
        findViewById(R.id.native_btn_switch).setOnClickListener(v -> {
            if (service != null && service.getPeer() != null) {
                service.getPeer().camera().switchCamera();
            }
        });

        NativeCallService.start(this, callId, chatId, fromUserId, title, body);
        bindService(new Intent(this, NativeCallService.class), connection, Context.BIND_AUTO_CREATE);
        // Activity is visible — kill heads-up / FSI so user is not left with push + UI.
        IncomingCallRingService.demoteToQuiet(this, callId);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (!callId.isEmpty()) {
            IncomingCallRingService.demoteToQuiet(this, callId);
        }
    }

    /** True while this activity is showing as a system PiP bubble. */
    public static boolean isInPipMode() {
        return sInPip;
    }

    private boolean canEnterPip() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && pipEligible
            && !finishing
            && !isInPictureInPictureMode();
    }

    /**
     * WhatsApp-style minimize: system PiP bubble + MainActivity (chats) underneath.
     */
    private void minimizeToPip(boolean openChats) {
        if (!canEnterPip()) return;
        // FLAG_SECURE blocks Picture-in-Picture on many OEMs.
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(false);
            setTurnScreenOn(false);
        }
        if (openChats) {
            Intent open = new Intent(this, MainActivity.class);
            open.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_CLEAR_TOP
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP
                    | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
            );
            open.putExtra("coachman_from_call_pip", true);
            startActivity(open);
        }
        try {
            PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder()
                .setAspectRatio(new Rational(9, 16));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setSeamlessResizeEnabled(true);
            }
            boolean ok = enterPictureInPictureMode(builder.build());
            NativeCallLogger.i("NATIVE_PIP_ENTER", callId, "ok=" + ok);
            if (!ok) {
                NativeCallLogger.w("NATIVE_PIP_ENTER_FAILED", callId, null);
            }
        } catch (Exception e) {
            NativeCallLogger.e("NATIVE_PIP_ENTER_FAILED", callId, e);
        }
    }

    private void applyPipChrome(boolean pip) {
        sInPip = pip;
        int chrome = pip ? View.GONE : View.VISIBLE;
        if (topScrim != null) topScrim.setVisibility(chrome);
        if (bottomScrim != null) bottomScrim.setVisibility(chrome);
        if (btnMinimize != null) btnMinimize.setVisibility(pip ? View.GONE : View.VISIBLE);
        if (pip) {
            ringControls.setVisibility(View.GONE);
            activeControls.setVisibility(View.GONE);
            liveTop.setVisibility(View.GONE);
            localRenderer.setVisibility(View.GONE);
            placeholder.setVisibility(View.GONE);
        } else if (pipEligible && !finishing) {
            showActiveUi();
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        }
        applyPipChrome(isInPictureInPictureMode);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode) {
        // Pre-API 26 stub path / older callback.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            super.onPictureInPictureModeChanged(isInPictureInPictureMode);
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            applyPipChrome(isInPictureInPictureMode);
        }
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        // Home / app switch during an active call → PiP (WhatsApp-like).
        if (canEnterPip()) {
            minimizeToPip(false);
        }
    }

    private static String peerInitial(String name) {
        String cleaned = name == null ? "" : name.replaceFirst("^@", "").trim();
        if (cleaned.isEmpty()) return "?";
        return cleaned.substring(0, 1).toUpperCase();
    }

    private void roundLocalPip() {
        localRenderer.setClipToOutline(true);
        localRenderer.setOutlineProvider(new ViewOutlineProvider() {
            @Override
            public void getOutline(View view, Outline outline) {
                outline.setRoundRect(0, 0, view.getWidth(), view.getHeight(), dp(14));
            }
        });
        localRenderer.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> v.invalidateOutline());
    }

    private float dp(float value) {
        return value * getResources().getDisplayMetrics().density;
    }

    private void refreshMuteUi() {
        btnMute.setBackgroundResource(muted ? R.drawable.bg_call_glass_active_circle : R.drawable.bg_call_glass_circle);
        btnMute.setImageResource(muted ? R.drawable.ic_call_mic_off : R.drawable.ic_call_mic);
        labelMute.setText(muted ? "Выкл" : "Микрофон");
        btnMute.setContentDescription(muted ? "Включить микрофон" : "Выключить микрофон");
    }

    private void refreshCameraUi() {
        btnCamera.setBackgroundResource(cameraOff ? R.drawable.bg_call_glass_active_circle : R.drawable.bg_call_glass_circle);
        btnCamera.setImageResource(cameraOff ? R.drawable.ic_call_video_off : R.drawable.ic_call_video);
        labelCamera.setText(cameraOff ? "Выкл" : "Камера");
        btnCamera.setContentDescription(cameraOff ? "Включить камеру" : "Выключить камеру");
    }

    private void setStatusText(String text) {
        statusView.setText(text);
        liveStatusView.setText(text);
    }

    private void startDurationTicker() {
        if (callActiveSinceMs > 0) return;
        callActiveSinceMs = System.currentTimeMillis();
        uiHandler.removeCallbacks(durationTick);
        setStatusText(formatDuration(0));
        uiHandler.postDelayed(durationTick, 1000);
    }

    private void stopDurationTicker() {
        uiHandler.removeCallbacks(durationTick);
        callActiveSinceMs = 0;
    }

    private static String formatDuration(long totalSec) {
        long sec = Math.max(0, totalSec);
        long h = sec / 3600;
        long m = (sec % 3600) / 60;
        long s = sec % 60;
        if (h > 0) {
            return h + ":" + pad2(m) + ":" + pad2(s);
        }
        return m + ":" + pad2(s);
    }

    private static String pad2(long n) {
        return n < 10 ? "0" + n : String.valueOf(n);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        bindExtras(intent);
        if (bound) applyPendingCallAction();
    }

    private void applyPendingCallAction() {
        if (service == null) return;
        if (autoReject) {
            autoReject = false;
            service.rejectCall();
            return;
        }
        if (autoAccept) {
            autoAccept = false;
            onAcceptClicked();
        }
    }

    private void initRenderersIfNeeded() {
        if (renderersReady || service == null || service.getPeer() == null) return;
        EglBase egl = service.getPeer().getEglBase();
        if (egl == null) return;
        remoteRenderer.init(egl.getEglBaseContext(), null);
        remoteRenderer.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL);
        remoteRenderer.setMirror(false);
        remoteRenderer.setEnableHardwareScaler(true);
        localRenderer.init(egl.getEglBaseContext(), null);
        localRenderer.setMirror(true);
        localRenderer.setZOrderMediaOverlay(true);
        renderersReady = true;
        if (pendingRemote != null) attachRemote(pendingRemote);
        if (pendingLocal != null) attachLocal(pendingLocal);
    }

    private void onAcceptClicked() {
        boolean cam = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        boolean mic = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        if (!cam || !mic) {
            showMediaPermissionDeniedUi();
            ActivityCompat.requestPermissions(
                this,
                new String[]{Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO},
                REQ_MEDIA
            );
            return;
        }
        if (service != null) service.acceptCall();
        showActiveUi();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_MEDIA) return;
        boolean cam = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        boolean mic = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        if (!cam || !mic) {
            showMediaPermissionDeniedUi();
            return;
        }
        NativeCallLogger.i("NATIVE_PERMISSION_GRANTED", callId);
        hideMediaPermissionDeniedUi();
        if (service != null) service.acceptCall();
        showActiveUi();
    }

    private void showMediaPermissionDeniedUi() {
        setStatusText("Нужны камера и микрофон");
        ringControls.setVisibility(View.VISIBLE);
        TextView settings = findViewById(R.id.native_btn_perm_settings);
        settings.setVisibility(View.VISIBLE);
        labelReject.setText("Завершить");
        labelAccept.setText("Повторить");
        btnReject.setContentDescription("Завершить");
        btnAccept.setContentDescription("Повторить");
        btnReject.setOnClickListener(v -> {
            if (service != null) service.hangup(true);
            else finishWithoutApp();
        });
        btnAccept.setOnClickListener(v -> ActivityCompat.requestPermissions(
            this,
            new String[]{Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO},
            REQ_MEDIA
        ));
        settings.setOnClickListener(v ->
            com.coachman.app.calls.permissions.CallPermissionCoordinator.openAppSettings(this)
        );
    }

    private void hideMediaPermissionDeniedUi() {
        TextView settings = findViewById(R.id.native_btn_perm_settings);
        settings.setVisibility(View.GONE);
        labelReject.setText("Отклонить");
        labelAccept.setText("Ответить");
        btnReject.setContentDescription("Отклонить");
        btnAccept.setContentDescription("Ответить");
        btnReject.setOnClickListener(v -> {
            if (service != null) service.rejectCall();
            else finishWithoutApp();
        });
        btnAccept.setOnClickListener(v -> onAcceptClicked());
    }

    private void showActiveUi() {
        pipEligible = true;
        if (isInPictureInPictureMode()) {
            applyPipChrome(true);
            return;
        }
        ringControls.setVisibility(View.GONE);
        activeControls.setVisibility(View.VISIBLE);
        liveTop.setVisibility(View.VISIBLE);
        localRenderer.setVisibility(View.VISIBLE);
        if (btnMinimize != null) btnMinimize.setVisibility(View.VISIBLE);
        if (topScrim != null) topScrim.setVisibility(View.VISIBLE);
        if (bottomScrim != null) bottomScrim.setVisibility(View.VISIBLE);
        setStatusText("Соединение…");
        refreshMuteUi();
        refreshCameraUi();
    }

    @Override
    public void onRemoteTrack(VideoTrack track) {
        runOnUiThread(() -> {
            pendingRemote = track;
            initRenderersIfNeeded();
            attachRemote(track);
        });
    }

    @Override
    public void onLocalTrack(VideoTrack track) {
        runOnUiThread(() -> {
            pendingLocal = track;
            initRenderersIfNeeded();
            attachLocal(track);
            });
    }

    @Override
    public void onState(NativeCallSessionStore.State state) {
        runOnUiThread(() -> {
            initRenderersIfNeeded();
            switch (state) {
                case PREVIEW_CONNECTING:
                    setStatusText("Подключение видео…");
                    break;
                case PREVIEW_VISIBLE:
                    setStatusText("Входящий видеозвонок");
                    break;
                case ANSWERING:
                case ACTIVE_CONNECTING:
                    setStatusText("Соединение…");
                    showActiveUi();
                    break;
                case ACTIVE:
                    showActiveUi();
                    startDurationTicker();
                                break;
                case ENDING:
                case ENDED:
                case FAILED:
                    stopDurationTicker();
                    break;
                default:
                    break;
            }
        });
    }

    private void attachRemote(VideoTrack track) {
        if (!renderersReady || track == null || remoteAttached) return;
        track.addSink(remoteRenderer);
        remoteAttached = true;
        placeholder.setVisibility(View.GONE);
        NativeCallLogger.i("NATIVE_FIRST_VIDEO_FRAME", callId, "sink-attached");
    }

    private void attachLocal(VideoTrack track) {
        if (!renderersReady || track == null || localAttached) return;
        track.addSink(localRenderer);
        localAttached = true;
        localRenderer.setVisibility(View.VISIBLE);
    }

    @Override
    public void onError(String message) {
        runOnUiThread(() -> setStatusText(message != null ? message : "Ошибка"));
    }

    @Override
    public void onEnded(boolean needsUnlock) {
        if (finishing) return;
        finishing = true;
        pipEligible = false;
        stopDurationTicker();
        IncomingCallRingService.dismissNow(this, callId);
        if (isInPictureInPictureMode() || sInPip) {
            sInPip = false;
            finishWithoutApp();
            return;
        }
        if (!needsUnlock) {
            finishWithoutApp();
            return;
        }
        KeyguardManager km = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        boolean locked = km != null && km.isDeviceLocked();
        if (!locked) {
            openMainAndFinish();
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && km != null) {
            statusView.setText("Звонок завершён");
            liveStatusView.setText("Звонок завершён");
            NativeCallLogger.i("KEYGUARD_REQUESTED", callId);
            km.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                @Override
                public void onDismissSucceeded() {
                    NativeCallLogger.i("KEYGUARD_SUCCEEDED", callId);
                    openMainAndFinish();
                }

                @Override
                public void onDismissCancelled() {
                    finishWithoutApp();
                }

                @Override
                public void onDismissError() {
                    finishWithoutApp();
                }
            });
            return;
        }
        finishWithoutApp();
    }

    private void openMainAndFinish() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(false);
            setTurnScreenOn(false);
        }
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(open);
        finish();
    }

    private void finishWithoutApp() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(false);
            setTurnScreenOn(false);
        }
        try {
            finishAndRemoveTask();
        } catch (Exception e) {
            finish();
        }
    }

    private void bindExtras(Intent intent) {
        if (intent == null) return;
        callId = safe(intent.getStringExtra(NativeCallService.EXTRA_CALL_ID));
        chatId = safe(intent.getStringExtra(NativeCallService.EXTRA_CHAT_ID));
        fromUserId = safe(intent.getStringExtra(NativeCallService.EXTRA_FROM_USER_ID));
        title = safe(intent.getStringExtra(NativeCallService.EXTRA_TITLE));
        body = safe(intent.getStringExtra(NativeCallService.EXTRA_BODY));
        lockedAtStart = intent.getBooleanExtra("lockedAtStart", true);
        autoAccept = intent.getBooleanExtra(EXTRA_AUTO_ACCEPT, false);
        autoReject = intent.getBooleanExtra(EXTRA_AUTO_REJECT, false);
        if (body.isEmpty()) body = "Собеседник";
        if (nameView != null && !body.isEmpty()) nameView.setText(body);
    }

    private static String safe(String v) {
        return v == null ? "" : v;
    }

    @Override
    protected void onDestroy() {
        sInPip = false;
        stopDurationTicker();
        if (bound) {
            if (service != null) service.removeListener(this);
            unbindService(connection);
            bound = false;
        }
        if (renderersReady) {
            remoteRenderer.release();
            localRenderer.release();
        }
        super.onDestroy();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (canEnterPip()) {
            minimizeToPip(true);
            return;
        }
        // Stay on call UI while ringing.
    }
}
