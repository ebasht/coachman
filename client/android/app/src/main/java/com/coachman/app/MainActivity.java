package com.coachman.app;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.WindowManager;

import com.coachman.app.calls.CallActionStore;
import com.coachman.app.calls.CoachmanCallsPlugin;
import com.coachman.app.calls.IncomingCallActivity;
import com.coachman.app.calls.IncomingCallRingService;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "MainActivityCalls";
    private static volatile MainActivity instance;
    private static volatile boolean resumed;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CoachmanCallsPlugin.class);
        super.onCreate(savedInstanceState);
        instance = this;
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        deliverCallIntent(getIntent());
    }

    @Override
    public void onResume() {
        super.onResume();
        resumed = true;
    }

    @Override
    public void onPause() {
        resumed = false;
        super.onPause();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        deliverCallIntent(intent);
    }

    @Override
    public void onDestroy() {
        if (instance == this) {
            instance = null;
            resumed = false;
        }
        super.onDestroy();
    }

    public static MainActivity getInstance() {
        return instance;
    }

    /** True while MainActivity is resumed (app open in foreground). */
    public static boolean isInForeground() {
        return instance != null && resumed;
    }

    /**
     * While a call is ringing/connecting/active, show MainActivity over the keyguard.
     * Must be cleared on idle so normal chat UI does not stay above the lock screen.
     */
    public void setCallWindowMode(boolean active) {
        runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                setShowWhenLocked(active);
                setTurnScreenOn(active);
            }
            if (active) {
                getWindow().addFlags(
                    WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                        | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                        | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                        | WindowManager.LayoutParams.FLAG_ALLOW_LOCK_WHILE_SCREEN_ON
                );
            } else {
                getWindow().clearFlags(
                    WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                        | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                        | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                        | WindowManager.LayoutParams.FLAG_ALLOW_LOCK_WHILE_SCREEN_ON
                );
            }
            Log.i(TAG, "setCallWindowMode active=" + active);
        });
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

        Log.i(TAG, "MainActivity intent received type=" + type + " callId=" + callId
            + " accept=" + autoAccept + " reject=" + autoReject);

        if (callId != null && !callId.isEmpty()) {
            if (autoAccept) {
                CoachmanCallsPlugin.suppressIncomingUi(callId);
                setCallWindowMode(true);
            }
            IncomingCallActivity.dismissActive(callId);
            IncomingCallRingService.dismissNow(this, callId);
        } else {
            IncomingCallRingService.dismissNow(this, null);
        }

        // Sole registration point for Capacitor / React.
        if (autoAccept || autoReject) {
            String action = autoAccept ? "accept" : "reject";
            CallActionStore.PendingAction pending = CallActionStore.put(
                this,
                action,
                callId != null ? callId : "",
                chatId != null ? chatId : "",
                fromUserId != null ? fromUserId : ""
            );
            if (pending != null) {
                CoachmanCallsPlugin.notifyCallAction(pending);
            }
        }

        intent.removeExtra("coachman_push_type");
    }
}
