package com.coachman.app.calls;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.WindowManager;
import android.widget.ImageButton;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

import com.coachman.app.MainActivity;
import com.coachman.app.R;

/**
 * Lock-screen incoming-call UI launched via notification full-screen intent.
 * Ringtone stays in {@link IncomingCallRingService}. WebRTC stays in MainActivity.
 * This Activity exists because launcher MainActivity often cannot appear over keyguard.
 */
public class IncomingCallActivity extends AppCompatActivity {
    private static final String TAG = "IncomingCallActivity";

    public static final String EXTRA_CALL_ID = "coachman_call_id";
    public static final String EXTRA_CHAT_ID = "coachman_chat_id";
    public static final String EXTRA_FROM_USER_ID = "coachman_from_user_id";
    public static final String EXTRA_TITLE = "coachman_title";
    public static final String EXTRA_BODY = "coachman_body";
    public static final String EXTRA_LOCKED_AT_START = "coachman_locked_at_start";

    private static final long RING_TIMEOUT_MS = 45_000L;
    private static volatile IncomingCallActivity activeInstance;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private String callId = "";
    private String chatId = "";
    private String fromUserId = "";
    private String title = "";
    private String body = "";
    private boolean lockedAtStart;
    private boolean finished;

    public static void dismissActive(String callId) {
        IncomingCallActivity instance = activeInstance;
        if (instance == null) return;
        if (callId != null && !callId.isEmpty() && !callId.equals(instance.callId)) return;
        instance.runOnUiThread(() -> {
            if (instance.finished) return;
            instance.finished = true;
            instance.handler.removeCallbacksAndMessages(null);
            instance.finish();
            instance.overridePendingTransition(0, 0);
        });
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Before super: required for reliable display over keyguard on API 27+.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
        super.onCreate(savedInstanceState);
        activeInstance = this;

        getWindow().addFlags(
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_ALLOW_LOCK_WHILE_SCREEN_ON
        );

        setContentView(R.layout.activity_incoming_call);
        bindIntent(getIntent());
        Log.i(TAG, "IncomingCallActivity opened callId=" + callId);

        CallSessionStore.put(
            this,
            callId,
            chatId,
            fromUserId,
            title,
            body,
            lockedAtStart
        );

        ImageButton decline = findViewById(R.id.btn_decline);
        ImageButton accept = findViewById(R.id.btn_accept);
        decline.setOnClickListener(v -> complete(false));
        accept.setOnClickListener(v -> complete(true));

        // Do not start MainActivity here — it would cover this lock-screen UI.
        // WebRTC boots when the user Answers (or Rejects to deliver the action).

        handler.postDelayed(() -> {
            if (!finished) {
                Log.i(TAG, "ring timeout callId=" + callId);
                IncomingCallRingService.dismissNow(this, callId);
                finished = true;
                finish();
            }
        }, RING_TIMEOUT_MS);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        bindIntent(intent);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (activeInstance == this) {
            activeInstance = null;
        }
        super.onDestroy();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // Stay on lock-screen call UI.
    }

    private void bindIntent(Intent intent) {
        if (intent == null) return;
        callId = safe(intent.getStringExtra(EXTRA_CALL_ID));
        chatId = safe(intent.getStringExtra(EXTRA_CHAT_ID));
        fromUserId = safe(intent.getStringExtra(EXTRA_FROM_USER_ID));
        title = safe(intent.getStringExtra(EXTRA_TITLE));
        body = safe(intent.getStringExtra(EXTRA_BODY));
        lockedAtStart = intent.getBooleanExtra(EXTRA_LOCKED_AT_START, true);
        if (title.isEmpty()) title = "Входящий видеозвонок";
        if (body.isEmpty()) body = "Собеседник";

        TextView label = findViewById(R.id.incoming_label);
        TextView caller = findViewById(R.id.incoming_caller);
        if (label != null) label.setText(title);
        if (caller != null) caller.setText(body);
    }

    private void startMainCallOnly(boolean accept, boolean reject) {
        Intent open = new Intent(this, MainActivity.class);
        open.setAction(accept ? IncomingCallRingService.ACTION_ACCEPT
            : reject ? IncomingCallRingService.ACTION_DECLINE
            : MainActivity.ACTION_INCOMING_CALL);
        open.addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
        );
        open.putExtra(MainActivity.EXTRA_MODE, MainActivity.MODE_CALL);
        open.putExtra(MainActivity.EXTRA_PUSH_TYPE, "incoming-call");
        open.putExtra(MainActivity.EXTRA_CALL_ID, callId);
        open.putExtra(MainActivity.EXTRA_CHAT_ID, chatId);
        open.putExtra(MainActivity.EXTRA_FROM_USER_ID, fromUserId);
        open.putExtra(MainActivity.EXTRA_TITLE, title);
        open.putExtra(MainActivity.EXTRA_BODY, body);
        open.putExtra(MainActivity.EXTRA_LOCKED_AT_START, lockedAtStart);
        open.putExtra(MainActivity.EXTRA_AUTO_ACCEPT, accept);
        open.putExtra(MainActivity.EXTRA_AUTO_REJECT, reject);
        try {
            startActivity(open);
        } catch (Exception e) {
            Log.e(TAG, "start MainActivity failed", e);
        }
    }

    private void complete(boolean accept) {
        if (finished) return;
        finished = true;
        handler.removeCallbacksAndMessages(null);
        Log.i(TAG, (accept ? "ANSWER_CLICKED" : "REJECT_CLICKED") + " callId=" + callId);
        IncomingCallRingService.dismissNow(this, callId);
        startMainCallOnly(accept, !accept);
        finish();
        overridePendingTransition(0, 0);
    }

    private static String safe(String v) {
        return v == null ? "" : v;
    }

    public static Intent createIntent(
        Context context,
        String callId,
        String chatId,
        String fromUserId,
        String title,
        String body,
        boolean lockedAtStart
    ) {
        Intent intent = new Intent(context, IncomingCallActivity.class);
        intent.setFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                | Intent.FLAG_ACTIVITY_NO_USER_ACTION
        );
        intent.putExtra(EXTRA_CALL_ID, callId);
        intent.putExtra(EXTRA_CHAT_ID, chatId);
        intent.putExtra(EXTRA_FROM_USER_ID, fromUserId);
        intent.putExtra(EXTRA_TITLE, title);
        intent.putExtra(EXTRA_BODY, body);
        intent.putExtra(EXTRA_LOCKED_AT_START, lockedAtStart);
        return intent;
    }
}
