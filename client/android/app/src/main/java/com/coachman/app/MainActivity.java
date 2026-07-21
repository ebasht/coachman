package com.coachman.app;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;

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
        // Keep call UI over lock screen — never requestDismissKeyguard (that forces PIN).
        applyLockScreenFlagsIfCall(getIntent());
        // Shrink WebView above the IME so compose / modals are not covered.
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        boolean fromCall = isCallLaunchIntent(getIntent());
        deliverCallIntent(getIntent());
        if (!fromCall) {
            maybePromptFullScreenIntent();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        applyLockScreenFlagsIfCall(intent);
        deliverCallIntent(intent);
    }

    /** Show MainActivity over keyguard for incoming/in-call — never requestDismissKeyguard. */
    private void applyLockScreenFlagsIfCall(Intent intent) {
        if (!isCallLaunchIntent(intent)) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
        getWindow().addFlags(
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_ALLOW_LOCK_WHILE_SCREEN_ON
        );
    }

    private static boolean isCallLaunchIntent(Intent intent) {
        if (intent == null) return false;
        String type = intent.getStringExtra("coachman_push_type");
        return type != null && !type.isEmpty();
    }

    private void maybePromptFullScreenIntent() {
        // Do not auto-open OEM settings here — jumping to MIUI permission screens
        // resumes MainActivity and previously raced with incoming-call FGS teardown.
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

        // Stop CallStyle / FGS heads-up immediately (Accept/Decline from popup).
        if (callId != null && !callId.isEmpty()) {
            if (autoAccept) {
                CoachmanCallsPlugin.suppressIncomingUi(callId);
            }
            IncomingCallActivity.dismissActive(callId);
            IncomingCallRingService.dismissNow(this, callId);
        } else {
            IncomingCallRingService.dismissNow(this, null);
        }

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
