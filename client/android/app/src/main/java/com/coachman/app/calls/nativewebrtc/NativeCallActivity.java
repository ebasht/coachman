package com.coachman.app.calls.nativewebrtc;

import android.Manifest;
import android.app.KeyguardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
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
 * Lock-screen native WebRTC UI — no WebView / Capacitor.
 */
public class NativeCallActivity extends AppCompatActivity implements NativeCallService.UiListener {
    private static final int REQ_MEDIA = 4501;

    private SurfaceViewRenderer remoteRenderer;
    private SurfaceViewRenderer localRenderer;
    private LinearLayout placeholder;
    private LinearLayout ringControls;
    private LinearLayout activeControls;
    private TextView nameView;
    private TextView statusView;

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
    private boolean muted;
    private boolean cameraOff;

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
        nameView = findViewById(R.id.native_call_name);
        statusView = findViewById(R.id.native_call_status);
        nameView.setText(body);

        findViewById(R.id.native_btn_accept).setOnClickListener(v -> onAcceptClicked());
        findViewById(R.id.native_btn_reject).setOnClickListener(v -> {
            if (service != null) service.rejectCall();
            else finishWithoutApp();
        });
        findViewById(R.id.native_btn_hangup).setOnClickListener(v -> {
            if (service != null) service.hangup(true);
        });
        findViewById(R.id.native_btn_mute).setOnClickListener(v -> {
            muted = !muted;
            if (service != null && service.getPeer() != null) {
                service.getPeer().audio().setMuted(muted);
            }
            ((Button) v).setText(muted ? "Микрофон выкл" : "Микрофон");
        });
        findViewById(R.id.native_btn_camera).setOnClickListener(v -> {
            cameraOff = !cameraOff;
            if (service != null && service.getPeer() != null) {
                service.getPeer().camera().setEnabled(!cameraOff);
            }
            ((Button) v).setText(cameraOff ? "Камера выкл" : "Камера");
        });
        findViewById(R.id.native_btn_switch).setOnClickListener(v -> {
            if (service != null && service.getPeer() != null) {
                service.getPeer().camera().switchCamera();
            }
        });

        NativeCallService.start(this, callId, chatId, fromUserId, title, body);
        bindService(new Intent(this, NativeCallService.class), connection, Context.BIND_AUTO_CREATE);
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
        statusView.setText("Нужны камера и микрофон. Видео собеседника остаётся на экране.");
        Button reject = findViewById(R.id.native_btn_reject);
        Button accept = findViewById(R.id.native_btn_accept);
        Button settings = findViewById(R.id.native_btn_perm_settings);
        ringControls.setVisibility(View.VISIBLE);
        settings.setVisibility(View.VISIBLE);
        reject.setText("Завершить");
        accept.setText("Повторить");
        reject.setOnClickListener(v -> {
            if (service != null) service.hangup(true);
            else finishWithoutApp();
        });
        accept.setOnClickListener(v -> ActivityCompat.requestPermissions(
            this,
            new String[]{Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO},
            REQ_MEDIA
        ));
        settings.setOnClickListener(v ->
            com.coachman.app.calls.permissions.CallPermissionCoordinator.openAppSettings(this)
        );
    }

    private void hideMediaPermissionDeniedUi() {
        Button reject = findViewById(R.id.native_btn_reject);
        Button accept = findViewById(R.id.native_btn_accept);
        Button settings = findViewById(R.id.native_btn_perm_settings);
        settings.setVisibility(View.GONE);
        reject.setText("Отклонить");
        accept.setText("Ответить");
        reject.setOnClickListener(v -> {
            if (service != null) service.rejectCall();
            else finishWithoutApp();
        });
        accept.setOnClickListener(v -> onAcceptClicked());
    }

    private void showActiveUi() {
        ringControls.setVisibility(View.GONE);
        activeControls.setVisibility(View.VISIBLE);
        localRenderer.setVisibility(View.VISIBLE);
        statusView.setText("Соединение…");
    }

    @Override
    public void onState(NativeCallSessionStore.State state) {
        initRenderersIfNeeded();
        switch (state) {
            case PREVIEW_CONNECTING:
                statusView.setText("Подключение видео…");
                break;
            case PREVIEW_VISIBLE:
                statusView.setText("Входящий видеозвонок");
                break;
            case ANSWERING:
            case ACTIVE_CONNECTING:
                statusView.setText("Соединение…");
                showActiveUi();
                break;
            case ACTIVE:
                statusView.setText("Идёт звонок");
                showActiveUi();
                break;
            default:
                break;
        }
    }

    @Override
    public void onRemoteTrack(VideoTrack track) {
        pendingRemote = track;
        initRenderersIfNeeded();
        attachRemote(track);
    }

    @Override
    public void onLocalTrack(VideoTrack track) {
        pendingLocal = track;
        initRenderersIfNeeded();
        attachLocal(track);
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
        statusView.setText(message != null ? message : "Ошибка");
    }

    @Override
    public void onEnded(boolean needsUnlock) {
        if (finishing) return;
        finishing = true;
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
