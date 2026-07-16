package com.coachman.app.calls;

import android.Manifest;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.coachman.app.MainActivity;
import com.coachman.app.R;
import com.getcapacitor.JSObject;

/**
 * Full-screen incoming call UI (lock-screen capable), similar to the system phone app.
 */
public class IncomingCallActivity extends AppCompatActivity {
    public static final String EXTRA_CALL_ID = "coachman_call_id";
    public static final String EXTRA_CHAT_ID = "coachman_chat_id";
    public static final String EXTRA_FROM_USER_ID = "coachman_from_user_id";
    public static final String EXTRA_TITLE = "coachman_title";
    public static final String EXTRA_BODY = "coachman_body";

    private static final long RING_TIMEOUT_MS = 45_000L;
    private static final int REQ_MEDIA = 4101;
    private static volatile IncomingCallActivity activeInstance;
    private static volatile String activeCallId;

    public static boolean isShowingFor(String callId) {
        IncomingCallActivity instance = activeInstance;
        return instance != null && callId != null && callId.equals(instance.callId) && !instance.finished;
    }

    private Ringtone ringtone;
    private Vibrator vibrator;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private String callId = "";
    private String chatId = "";
    private String fromUserId = "";
    private boolean finished;

    public static void start(
        Context context,
        String callId,
        String chatId,
        String fromUserId,
        String title,
        String body
    ) {
        Intent intent = new Intent(context, IncomingCallActivity.class);
        intent.addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
        );
        intent.putExtra(EXTRA_CALL_ID, callId);
        intent.putExtra(EXTRA_CHAT_ID, chatId);
        intent.putExtra(EXTRA_FROM_USER_ID, fromUserId != null ? fromUserId : "");
        intent.putExtra(EXTRA_TITLE, title != null ? title : "Входящий видеозвонок");
        intent.putExtra(EXTRA_BODY, body != null ? body : "Собеседник");
        context.startActivity(intent);
    }

    /** Close ringing UI without starting a new activity (avoids race with present). */
    public static void dismissActive(String callId) {
        IncomingCallActivity instance = activeInstance;
        if (instance == null) return;
        if (callId != null && !callId.isEmpty() && !callId.equals(instance.callId)) return;
        instance.runOnUiThread(() -> {
            if (instance.finished) return;
            instance.finished = true;
            instance.stopRinging();
            CoachmanCallsPlugin.cancelIncomingNotification(instance, instance.callId);
            IncomingCallRingService.stop(instance);
            instance.finish();
            instance.overridePendingTransition(0, 0);
        });
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        activeInstance = this;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
            KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
            if (km != null) {
                km.requestDismissKeyguard(this, null);
            }
        } else {
            getWindow().addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                    | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
            );
        }
        getWindow().addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_ALLOW_LOCK_WHILE_SCREEN_ON
        );

        setContentView(R.layout.activity_incoming_call);
        bindIntent(getIntent());

        Button accept = findViewById(R.id.btn_accept);
        Button decline = findViewById(R.id.btn_decline);
        accept.setOnClickListener(v -> complete("accept"));
        decline.setOnClickListener(v -> complete("reject"));

        startRinging();
        handler.postDelayed(() -> {
            if (!finished) complete("timeout");
        }, RING_TIMEOUT_MS);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        bindIntent(intent);
    }

    private void bindIntent(Intent intent) {
        if (intent == null) return;
        callId = safe(intent.getStringExtra(EXTRA_CALL_ID));
        chatId = safe(intent.getStringExtra(EXTRA_CHAT_ID));
        fromUserId = safe(intent.getStringExtra(EXTRA_FROM_USER_ID));
        activeCallId = callId;
        String title = safe(intent.getStringExtra(EXTRA_TITLE));
        String body = safe(intent.getStringExtra(EXTRA_BODY));
        if (title.isEmpty()) title = "Входящий видеозвонок";
        if (body.isEmpty()) body = "Собеседник";

        TextView label = findViewById(R.id.incoming_label);
        TextView caller = findViewById(R.id.incoming_caller);
        if (label != null) label.setText(title);
        if (caller != null) caller.setText(body);
    }

    private void complete(String action) {
        if (finished) return;
        finished = true;
        stopRinging();
        CoachmanCallsPlugin.cancelIncomingNotification(this, callId);
        IncomingCallRingService.stop(this);

        if ("timeout".equals(action)) {
            finish();
            overridePendingTransition(0, 0);
            return;
        }

        if ("accept".equals(action)) {
            CoachmanCallsPlugin.suppressIncomingUi(callId);
            TextView label = findViewById(R.id.incoming_label);
            if (label != null) label.setText("Подключение…");
            Button accept = findViewById(R.id.btn_accept);
            Button decline = findViewById(R.id.btn_decline);
            if (accept != null) accept.setEnabled(false);
            if (decline != null) decline.setEnabled(false);
            if (!hasMediaPermissions()) {
                ActivityCompat.requestPermissions(
                    this,
                    new String[] { Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO },
                    REQ_MEDIA
                );
                return;
            }
            launchMainWithAction(true);
            return;
        }

        // reject
        launchMainWithAction(false);
    }

    private boolean hasMediaPermissions() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED
            && ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED;
    }

    private void launchMainWithAction(boolean accept) {
        JSObject data = new JSObject();
        data.put("type", "incoming-call");
        data.put("callId", callId);
        data.put("chatId", chatId);
        data.put("fromUserId", fromUserId);
        if (accept) {
            data.put("autoAccept", true);
        } else {
            data.put("autoReject", true);
        }
        CoachmanCallsPlugin.queueLaunchCall(data);

        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(
            Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_NEW_TASK
        );
        open.putExtra("coachman_push_type", "incoming-call");
        open.putExtra("coachman_call_id", callId);
        open.putExtra("coachman_chat_id", chatId);
        open.putExtra("coachman_from_user_id", fromUserId);
        open.putExtra("coachman_auto_accept", accept);
        open.putExtra("coachman_auto_reject", !accept);
        startActivity(open);
        overridePendingTransition(0, 0);
        finish();
        overridePendingTransition(0, 0);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_MEDIA) return;
        // Proceed even if denied — WebView will surface the error; avoid leaving user stuck.
        launchMainWithAction(true);
    }

    private void startRinging() {
        try {
            Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            ringtone = RingtoneManager.getRingtone(this, uri);
            if (ringtone != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    ringtone.setLooping(true);
                }
                AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
                ringtone.setAudioAttributes(attrs);
                ringtone.play();
            }
        } catch (Exception ignored) {
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                VibratorManager vm = (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                vibrator = vm != null ? vm.getDefaultVibrator() : null;
            } else {
                vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            }
            if (vibrator != null) {
                long[] pattern = new long[] { 0, 800, 400, 800, 400 };
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
                } else {
                    vibrator.vibrate(pattern, 0);
                }
            }
        } catch (Exception ignored) {
        }
    }

    private void stopRinging() {
        handler.removeCallbacksAndMessages(null);
        try {
            if (ringtone != null && ringtone.isPlaying()) ringtone.stop();
        } catch (Exception ignored) {
        }
        ringtone = null;
        try {
            if (vibrator != null) vibrator.cancel();
        } catch (Exception ignored) {
        }
        vibrator = null;
    }

    @Override
    protected void onDestroy() {
        stopRinging();
        if (activeInstance == this) {
            activeInstance = null;
        }
        if (callId.equals(activeCallId)) {
            activeCallId = null;
        }
        super.onDestroy();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // Ignore back while ringing — use Decline.
    }

    private static String safe(String v) {
        return v == null ? "" : v;
    }
}
