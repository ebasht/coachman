package com.coachman.app.calls.nativewebrtc;

import android.graphics.Outline;
import android.Manifest;
import android.app.KeyguardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.view.View;
import android.view.ViewOutlineProvider;
import android.view.WindowManager;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
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
 */
public class NativeCallActivity extends AppCompatActivity implements NativeCallService.UiListener {
    private static final int REQ_MEDIA = 4501;

    private SurfaceViewRenderer remoteRenderer;
    private SurfaceViewRenderer localRenderer;
    private LinearLayout placeholder;
    private LinearLayout ringControls;
    private LinearLayout activeControls;
    private LinearLayout liveTop;
    private TextView nameView;
    private TextView statusView;
    private TextView liveNameView;
    private TextView liveStatusView;
    private TextView avatarLetterView;
    private TextView labelReject;
    private TextView labelAccept;
    private TextView labelMute;
    private TextView labelCamera;
    private TextView labelScreen;
    private ImageButton btnMute;
    private ImageButton btnCamera;
    private ImageButton btnScreen;
    private ImageButton btnSwitch;
    private ImageButton btnAccept;
    private ImageButton btnReject;
    private View switchWrap;

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
    private VideoTrack pendingRemote;
    private VideoTrack pendingLocal;
    private VideoTrack attachedLocalTrack;
    private Intent pendingScreenShareData;
    private boolean muted;
    private boolean cameraOff;
    private boolean secureFlagClearedForShare;
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

    private final ActivityResultLauncher<Intent> screenCaptureLauncher =
        registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            if (result.getResultCode() != RESULT_OK || result.getData() == null) {
                Toast.makeText(this, "Демонстрация экрана отменена", Toast.LENGTH_SHORT).show();
                pendingScreenShareData = null;
                refreshScreenShareUi();
                return;
            }
            beginScreenShareWithData(result.getData());
        });

    private final ServiceConnection connection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            service = ((NativeCallService.LocalBinder) binder).getService();
            service.addListener(NativeCallActivity.this);
            bound = true;
            applyPendingCallAction();
            if (pendingScreenShareData != null) {
                Intent data = pendingScreenShareData;
                pendingScreenShareData = null;
                beginScreenShareWithData(data);
            }
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
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
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
        nameView = findViewById(R.id.native_call_name);
        statusView = findViewById(R.id.native_call_status);
        liveNameView = findViewById(R.id.native_live_name);
        liveStatusView = findViewById(R.id.native_live_status);
        avatarLetterView = findViewById(R.id.native_call_avatar_letter);
        labelReject = findViewById(R.id.native_label_reject);
        labelAccept = findViewById(R.id.native_label_accept);
        labelMute = findViewById(R.id.native_label_mute);
        labelCamera = findViewById(R.id.native_label_camera);
        labelScreen = findViewById(R.id.native_label_screen);
        btnMute = findViewById(R.id.native_btn_mute);
        btnCamera = findViewById(R.id.native_btn_camera);
        btnScreen = findViewById(R.id.native_btn_screen);
        btnSwitch = findViewById(R.id.native_btn_switch);
        btnAccept = findViewById(R.id.native_btn_accept);
        btnReject = findViewById(R.id.native_btn_reject);
        switchWrap = findViewById(R.id.native_switch_wrap);

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
        btnMute.setOnClickListener(v -> {
            muted = !muted;
            if (service != null && service.getPeer() != null) {
                service.getPeer().audio().setMuted(muted);
            }
            refreshMuteUi();
        });
        btnCamera.setOnClickListener(v -> {
            if (isScreenSharing()) return;
            cameraOff = !cameraOff;
            if (service != null && service.getPeer() != null) {
                service.getPeer().setCameraEnabled(!cameraOff);
            }
            refreshCameraUi();
        });
        btnScreen.setOnClickListener(v -> onScreenShareClicked());
        btnSwitch.setOnClickListener(v -> {
            if (isScreenSharing()) return;
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
        boolean sharing = isScreenSharing();
        btnCamera.setEnabled(!sharing);
        btnCamera.setAlpha(sharing ? 0.4f : 1f);
        btnCamera.setBackgroundResource(cameraOff ? R.drawable.bg_call_glass_active_circle : R.drawable.bg_call_glass_circle);
        btnCamera.setImageResource(cameraOff ? R.drawable.ic_call_video_off : R.drawable.ic_call_video);
        labelCamera.setText(cameraOff ? "Выкл" : "Камера");
        btnCamera.setContentDescription(cameraOff ? "Включить камеру" : "Выключить камеру");
    }

    private void refreshScreenShareUi() {
        boolean sharing = isScreenSharing();
        applySecureFlagForShare(sharing);
        btnScreen.setBackgroundResource(sharing ? R.drawable.bg_call_glass_active_circle : R.drawable.bg_call_glass_circle);
        labelScreen.setText(sharing ? "Стоп экран" : "Экран");
        btnScreen.setContentDescription(sharing ? "Остановить демонстрацию экрана" : "Демонстрация экрана");
        if (switchWrap != null) {
            switchWrap.setAlpha(sharing ? 0.4f : 1f);
            switchWrap.setEnabled(!sharing);
        }
        if (btnSwitch != null) {
            btnSwitch.setEnabled(!sharing);
        }
        if (localRenderer != null && renderersReady) {
            localRenderer.setMirror(!sharing);
        }
        refreshCameraUi();
    }

    /** FLAG_SECURE blacks out this window in MediaProjection — clear while sharing. */
    private void applySecureFlagForShare(boolean sharing) {
        if (sharing && !secureFlagClearedForShare) {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            secureFlagClearedForShare = true;
        } else if (!sharing && secureFlagClearedForShare) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            secureFlagClearedForShare = false;
        }
    }

    private boolean isScreenSharing() {
        return service != null && service.isScreenSharing();
    }

    private void onScreenShareClicked() {
        if (service == null) {
            Toast.makeText(this, "Сервис звонка ещё не готов", Toast.LENGTH_SHORT).show();
            return;
        }
        if (service.isScreenSharing()) {
            service.stopScreenShare();
            refreshScreenShareUi();
            return;
        }
        NativeCallSessionStore.State st = service.getState();
        if (st != NativeCallSessionStore.State.ACTIVE
            && st != NativeCallSessionStore.State.ACTIVE_CONNECTING) {
            Toast.makeText(this, "Дождитесь соединения", Toast.LENGTH_SHORT).show();
            return;
        }
        MediaProjectionManager mpm =
            (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        if (mpm == null) {
            Toast.makeText(this, "Демонстрация экрана недоступна", Toast.LENGTH_SHORT).show();
            return;
        }
        screenCaptureLauncher.launch(mpm.createScreenCaptureIntent());
    }

    private void beginScreenShareWithData(Intent projectionData) {
        if (projectionData == null) return;
        // Clear before capture starts so the first frames are not black.
        applySecureFlagForShare(true);
        // Deliver via startService so capture starts even if the Activity↔Service
        // binder briefly disconnected while the system capture UI was open.
        Intent i = new Intent(this, NativeCallService.class);
        i.setAction(NativeCallService.ACTION_START_SCREEN_SHARE);
        i.putExtra(NativeCallService.EXTRA_PROJECTION_DATA, projectionData);
        try {
            startService(i);
        } catch (Exception e) {
            NativeCallLogger.e("NATIVE_SCREEN_SHARE_START_SERVICE_FAIL", callId, e);
            if (service != null) {
                service.startScreenShare(projectionData);
            } else {
                pendingScreenShareData = projectionData;
                Toast.makeText(this, "Запуск демонстрации…", Toast.LENGTH_SHORT).show();
                return;
            }
        }
        uiHandler.postDelayed(this::refreshScreenShareUi, 400);
        uiHandler.postDelayed(() -> {
            refreshScreenShareUi();
            if (service != null && service.isScreenSharing()) {
                Toast.makeText(this, "Демонстрация экрана включена", Toast.LENGTH_SHORT).show();
            }
        }, 700);
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
        ringControls.setVisibility(View.GONE);
        activeControls.setVisibility(View.VISIBLE);
        liveTop.setVisibility(View.VISIBLE);
        localRenderer.setVisibility(View.VISIBLE);
        setStatusText("Соединение…");
        refreshMuteUi();
        refreshCameraUi();
        refreshScreenShareUi();
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
            refreshScreenShareUi();
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
                    refreshScreenShareUi();
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
        if (!renderersReady || track == null) return;
        if (attachedLocalTrack == track && localAttached) return;
        if (attachedLocalTrack != null) {
            try {
                attachedLocalTrack.removeSink(localRenderer);
            } catch (Exception ignored) {
            }
        }
        track.addSink(localRenderer);
        attachedLocalTrack = track;
        localAttached = true;
        localRenderer.setMirror(!isScreenSharing());
        localRenderer.setVisibility(View.VISIBLE);
    }

    @Override
    public void onError(String message) {
        runOnUiThread(() -> {
            setStatusText(message != null ? message : "Ошибка");
            if (message != null && !message.isEmpty()) {
                Toast.makeText(this, message, Toast.LENGTH_LONG).show();
            }
        });
    }

    @Override
    public void onEnded(boolean needsUnlock) {
        if (finishing) return;
        finishing = true;
        stopDurationTicker();
        IncomingCallRingService.dismissNow(this, callId);
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
        // Stay on call UI.
    }
}
