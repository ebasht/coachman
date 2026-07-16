package com.coachman.app;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;

import com.coachman.app.calls.CoachmanCallsPlugin;
import com.coachman.app.calls.IncomingCallActivity;
import com.coachman.app.calls.IncomingCallRingService;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSObject;

public class MainActivity extends BridgeActivity {
    private static final String PREFS = "coachman_native";
    private static final String KEY_FSI_PROMPTED = "fsi_prompted_v1";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CoachmanCallsPlugin.class);
        super.onCreate(savedInstanceState);
        deliverCallIntent(getIntent());
        maybePromptFullScreenIntent();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        deliverCallIntent(intent);
    }

    private void maybePromptFullScreenIntent() {
        if (CoachmanCallsPlugin.canUseFullScreenIntent(this)) return;
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        // Always re-prompt once per cold start until granted — release installs need this
        // for lock-screen incoming calls (USE_FULL_SCREEN_INTENT is not auto-granted).
        if (prefs.getBoolean(KEY_FSI_PROMPTED, false)) {
            // Still open settings every few launches until user grants.
            long last = prefs.getLong("fsi_last_prompt_ms", 0L);
            if (System.currentTimeMillis() - last < 24L * 60L * 60L * 1000L) return;
        }
        prefs.edit()
            .putBoolean(KEY_FSI_PROMPTED, true)
            .putLong("fsi_last_prompt_ms", System.currentTimeMillis())
            .apply();
        getWindow().getDecorView().postDelayed(
            () -> CoachmanCallsPlugin.openFullScreenIntentSettings(this),
            800
        );
    }

    private void deliverCallIntent(Intent intent) {
        if (intent == null) return;
        String type = intent.getStringExtra("coachman_push_type");
        if (type == null || type.isEmpty()) return;

        String callId = intent.getStringExtra("coachman_call_id");
        String chatId = intent.getStringExtra("coachman_chat_id");
        String fromUserId = intent.getStringExtra("coachman_from_user_id");
        boolean autoAccept = intent.getBooleanExtra("coachman_auto_accept", false);
        boolean autoReject = intent.getBooleanExtra("coachman_auto_reject", false);

        // Stop heads-up ringing immediately (Accept/Decline from CallStyle popup).
        if (callId != null && !callId.isEmpty()) {
            if (autoAccept) {
                CoachmanCallsPlugin.suppressIncomingUi(callId);
            }
            IncomingCallActivity.dismissActive(callId);
            CoachmanCallsPlugin.cancelIncomingNotification(this, callId);
        }
        IncomingCallRingService.stop(this);

        JSObject data = new JSObject();
        data.put("type", type);
        if (callId != null) data.put("callId", callId);
        if (chatId != null) data.put("chatId", chatId);
        if (fromUserId != null) data.put("fromUserId", fromUserId);
        if (autoAccept) {
            data.put("autoAccept", "true");
        }
        if (autoReject) {
            data.put("autoReject", "true");
        }
        CoachmanCallsPlugin.queueLaunchCall(data);
        intent.removeExtra("coachman_push_type");
    }
}
