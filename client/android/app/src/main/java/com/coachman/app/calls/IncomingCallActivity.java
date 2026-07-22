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
 * Lock-screen capable incoming-call UI only. Ringtone/vibration live in
 * {@link IncomingCallRingService}. Accept/Reject open MainActivity with extras —
 * MainActivity is the sole registrar into {@link CallActionStore}.
 */
public class IncomingCallActivity extends AppCompatActivity {
    private static final String TAG = "IncomingCallActivity";

    public static final String EXTRA_CALL_ID = "coachman_call_id";
    public static final String EXTRA_CHAT_ID = "coachman_chat_id";
    public static final String EXTRA_FROM_USER_ID = "coachman_from_user_id";
    public static final String EXTRA_TITLE = "coachman_title";
    public static final String EXTRA_BODY = "coachman_body";

    private static final long RING_TIMEOUT_MS = 45_000L;
    private static volatile IncomingCallActivity activeInstance;
    private static volatile String activeCallId;

    public static boolean isShowingFor(String callId) {
        IncomingCallActivity instance = activeInstance;
        return instance != null && callId != null && callId.equals(instance.callId) && !instance.finished;
    }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private String callId = "";
    private String chatId = "";
    private String fromUserId = "";
    private boolean finished;

    /** Close ringing UI without starting MainActivity. */
    public static void dismissActive(String callId) {
        IncomingCallActivity instance = activeInstance;
        if (instance == null) return;
        if (callId != null && !callId.isEmpty() && !callId.equals(instance.callId)) return;
        instance.runOnUiThread(() -> {
            if (instance.finished) return;
            instance.finished = true;
            instance.handler.removeCallbacksAndMessages(null);
            IncomingCallRingService.dismissNow(instance, instance.callId);
            instance.finish();
            instance.overridePendingTransition(0, 0);
        });
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
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

        ImageButton accept = findViewById(R.id.btn_accept);
        ImageButton decline = findViewById(R.id.btn_decline);
        accept.setOnClickListener(v -> complete(true));
        decline.setOnClickListener(v -> complete(false));

        handler.postDelayed(() -> {
            if (!finished) {
                finished = true;
                IncomingCallRingService.dismissNow(this, callId);
                finish();
                overridePendingTransition(0, 0);
            }
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

    private void complete(boolean accept) {
        if (finished) return;
        finished = true;
        handler.removeCallbacksAndMessages(null);
        Log.i(TAG, (accept ? "accept" : "reject") + " clicked callId=" + callId);

        if (accept) {
            CoachmanCallsPlugin.suppressIncomingUi(callId);
            TextView label = findViewById(R.id.incoming_label);
            if (label != null) label.setText("Подключение…");
            ImageButton acceptBtn = findViewById(R.id.btn_accept);
            ImageButton declineBtn = findViewById(R.id.btn_decline);
            if (acceptBtn != null) acceptBtn.setEnabled(false);
            if (declineBtn != null) declineBtn.setEnabled(false);
        }

        IncomingCallRingService.dismissNow(this, callId);

        // Intent extras only — MainActivity.deliverCallIntent persists + notifies JS.
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
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
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
