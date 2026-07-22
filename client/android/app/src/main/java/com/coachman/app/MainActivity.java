package com.coachman.app;

import android.app.KeyguardManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;

import com.coachman.app.calls.CallActionStore;
import com.coachman.app.calls.CallGateView;
import com.coachman.app.calls.CallSessionStore;
import com.coachman.app.calls.CoachmanCallsPlugin;
import com.coachman.app.calls.IncomingCallActivity;
import com.coachman.app.calls.IncomingCallRingService;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSObject;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "MainActivityCalls";

    public static final String ACTION_INCOMING_CALL = "com.coachman.app.ACTION_INCOMING_CALL";
    public static final String EXTRA_MODE = "coachman_mode";
    public static final String EXTRA_CALL_ID = "coachman_call_id";
    public static final String EXTRA_CHAT_ID = "coachman_chat_id";
    public static final String EXTRA_FROM_USER_ID = "coachman_from_user_id";
    public static final String EXTRA_TITLE = "coachman_title";
    public static final String EXTRA_BODY = "coachman_body";
    public static final String EXTRA_LOCKED_AT_START = "coachman_locked_at_start";
    public static final String EXTRA_PUSH_TYPE = "coachman_push_type";
    public static final String EXTRA_AUTO_ACCEPT = "coachman_auto_accept";
    public static final String EXTRA_AUTO_REJECT = "coachman_auto_reject";
    public static final String MODE_CALL = "call";

    private static volatile MainActivity instance;
    private static volatile boolean resumed;

    private CallGateView callGate;
    private String callOnlyCallId = "";
    private boolean callOnlyActive;
    private boolean secureFlagOwned;
    private boolean awaitingKeyguard;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        Intent launch = getIntent();
        boolean callMode = isCallModeIntent(launch);
        if (callMode) {
            setTheme(R.style.IncomingCallTheme);
            // Before super.onCreate — required to appear over keyguard on many OEMs.
            applyCallWindowMode(true);
        }
        registerPlugin(CoachmanCallsPlugin.class);
        super.onCreate(savedInstanceState);
        instance = this;
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        deliverCallIntent(getIntent());
        // Restore gate after process recreation if session still valid.
        if (!callOnlyActive) {
            CallSessionStore.Session session = CallSessionStore.peek(this);
            if (session != null) {
                enterCallOnlyMode(session, false, false);
            }
        }
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

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (callOnlyActive) {
            Log.i(TAG, "back consumed in call-only callId=" + callOnlyCallId);
            return;
        }
        super.onBackPressed();
    }

    public static MainActivity getInstance() {
        return instance;
    }

    public static boolean isInForeground() {
        return instance != null && resumed;
    }

    public static boolean isInCallOnlyMode() {
        MainActivity a = instance;
        return a != null && a.callOnlyActive;
    }

    public void setCallWindowMode(boolean active) {
        runOnUiThread(() -> applyCallWindowMode(active));
    }

    private void applyCallWindowMode(boolean active) {
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
    }

    /** Opaque gate must be visible before enabling show-when-locked. */
    public void enterCallOnlyMode(CallSessionStore.Session session, boolean autoAccept, boolean autoReject) {
        if (session == null || session.callId.isEmpty()) return;
        runOnUiThread(() -> {
            callOnlyCallId = session.callId;
            callOnlyActive = true;
            awaitingKeyguard = false;
            ensureCallGate();
            callGate.bind(session.title, session.body, "Подключение видео…");
            callGate.setActionsEnabled(!autoAccept && !autoReject);
            callGate.setVisibility(View.VISIBLE);
            setSecure(true);
            applyCallWindowMode(true);
            Log.i(TAG, "MAIN_ACTIVITY_CALL_MODE CALL_GATE_SHOWN callId=" + session.callId
                + " lockedAtStart=" + session.lockedAtStart);
        });
    }

    public void onCallUiReady(String callId) {
        runOnUiThread(() -> {
            if (!callOnlyActive) return;
            if (callId == null || callId.isEmpty() || !callId.equals(callOnlyCallId)) {
                Log.w(TAG, "CALL_UI_READY ignored want=" + callOnlyCallId + " got=" + callId);
                return;
            }
            if (callGate != null) {
                callGate.setVisibility(View.GONE);
            }
            Log.i(TAG, "CALL_UI_READY gate hidden callId=" + callId);
        });
    }

    public void showPostCallGate(String callId) {
        runOnUiThread(() -> {
            if (callId != null && !callId.isEmpty()) {
                callOnlyCallId = callId;
            }
            callOnlyActive = true;
            ensureCallGate();
            callGate.showEnded();
            callGate.setVisibility(View.VISIBLE);
            setSecure(true);
            Log.i(TAG, "POST_CALL_GATE_SHOWN callId=" + callOnlyCallId);
        });
    }

    /**
     * After an accepted call ends: unlock if needed, then reveal normal app.
     */
    public void finishCallAndOpenApp(String callId, FinishCallback callback) {
        runOnUiThread(() -> {
            if (callId != null && !callId.isEmpty() && !callOnlyCallId.isEmpty()
                && !callId.equals(callOnlyCallId)) {
                Log.w(TAG, "finishCall mismatch callId=" + callId);
                if (callback != null) callback.onDone(false);
                return;
            }
            IncomingCallRingService.dismissNow(this, callId);
            CallSessionStore.clearIfCall(this, callId);
            showPostCallGate(callId != null ? callId : callOnlyCallId);

            KeyguardManager km = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
            boolean locked = km != null && km.isDeviceLocked();
            if (!locked) {
                clearCallOnlyMode();
                if (callback != null) callback.onDone(true);
                return;
            }
            if (awaitingKeyguard) {
                if (callback != null) callback.onDone(false);
                return;
            }
            awaitingKeyguard = true;
            Log.i(TAG, "KEYGUARD_DISMISS_REQUESTED callId=" + callOnlyCallId);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && km != null) {
                km.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                    @Override
                    public void onDismissSucceeded() {
                        Log.i(TAG, "KEYGUARD_DISMISS_SUCCEEDED callId=" + callOnlyCallId);
                        awaitingKeyguard = false;
                        clearCallOnlyMode();
                        if (callback != null) callback.onDone(true);
                    }

                    @Override
                    public void onDismissCancelled() {
                        Log.i(TAG, "KEYGUARD_DISMISS_CANCELLED callId=" + callOnlyCallId);
                        awaitingKeyguard = false;
                        leaveBehindLockScreen();
                        if (callback != null) callback.onDone(false);
                    }

                    @Override
                    public void onDismissError() {
                        Log.w(TAG, "KEYGUARD_DISMISS_ERROR callId=" + callOnlyCallId);
                        awaitingKeyguard = false;
                        leaveBehindLockScreen();
                        if (callback != null) callback.onDone(false);
                    }
                });
            } else {
                awaitingKeyguard = false;
                leaveBehindLockScreen();
                if (callback != null) callback.onDone(false);
            }
        });
    }

    /** Reject / missed / remote hangup before answer — never unlock into chats. */
    public void closeCallOnlyMode(String callId) {
        runOnUiThread(() -> {
            if (callId != null && !callId.isEmpty() && !callOnlyCallId.isEmpty()
                && !callId.equals(callOnlyCallId)) {
                return;
            }
            IncomingCallRingService.dismissNow(this, callId);
            CallSessionStore.clearIfCall(this, callId);
            CallActionStore.clear(this);
            KeyguardManager km = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
            boolean locked = km != null && km.isDeviceLocked();
            if (locked) {
                leaveBehindLockScreen();
            } else {
                clearCallOnlyMode();
            }
            Log.i(TAG, "CALL_MODE_CLEARED (close) callId=" + callId + " locked=" + locked);
        });
    }

    public void clearCallOnlyMode() {
        runOnUiThread(() -> {
            callOnlyActive = false;
            awaitingKeyguard = false;
            callOnlyCallId = "";
            if (callGate != null) {
                callGate.setVisibility(View.GONE);
            }
            applyCallWindowMode(false);
            setSecure(false);
            CallSessionStore.clear(this);
            Log.i(TAG, "CALL_MODE_CLEARED");
        });
    }

    public JSObject getCallLaunchContextJs() {
        CallSessionStore.Session session = CallSessionStore.peek(this);
        if (session == null && !callOnlyActive) {
            JSObject empty = new JSObject();
            empty.put("active", false);
            return empty;
        }
        if (session != null) {
            JSObject o = session.toJsObject();
            o.put("active", true);
            return o;
        }
        JSObject o = new JSObject();
        o.put("active", callOnlyActive);
        o.put("callId", callOnlyCallId);
        return o;
    }

    private void leaveBehindLockScreen() {
        applyCallWindowMode(false);
        setSecure(false);
        callOnlyActive = false;
        if (callGate != null) {
            callGate.setVisibility(View.GONE);
        }
        try {
            finishAndRemoveTask();
        } catch (Exception e) {
            moveTaskToBack(true);
        }
    }

    private void ensureCallGate() {
        if (callGate != null) return;
        ViewGroup content = findViewById(android.R.id.content);
        if (content == null) return;
        callGate = new CallGateView(this);
        callGate.setListener(new CallGateView.Listener() {
            @Override
            public void onAccept() {
                Log.i(TAG, "ANSWER_CLICKED (gate) callId=" + callOnlyCallId);
                persistAndNotifyAction("accept");
                callGate.setActionsEnabled(false);
                callGate.setStatus("Соединение…");
                IncomingCallRingService.dismissNow(MainActivity.this, callOnlyCallId);
            }

            @Override
            public void onReject() {
                Log.i(TAG, "REJECT_CLICKED (gate) callId=" + callOnlyCallId);
                persistAndNotifyAction("reject");
                IncomingCallRingService.dismissNow(MainActivity.this, callOnlyCallId);
                closeCallOnlyMode(callOnlyCallId);
            }
        });
        content.addView(
            callGate,
            new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        );
    }

    private void persistAndNotifyAction(String action) {
        CallSessionStore.Session session = CallSessionStore.peek(this);
        String callId = session != null ? session.callId : callOnlyCallId;
        String chatId = session != null ? session.chatId : "";
        String fromUserId = session != null ? session.fromUserId : "";
        CallActionStore.PendingAction pending = CallActionStore.put(
            this, action, callId, chatId, fromUserId
        );
        if (pending != null) {
            CoachmanCallsPlugin.notifyCallAction(pending);
        }
    }

    private void setSecure(boolean on) {
        if (on) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            secureFlagOwned = true;
        } else if (secureFlagOwned) {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            secureFlagOwned = false;
        }
    }

    private void deliverCallIntent(Intent intent) {
        if (intent == null) return;

        boolean callMode = isCallModeIntent(intent);
        String callId = intent.getStringExtra(EXTRA_CALL_ID);
        String chatId = intent.getStringExtra(EXTRA_CHAT_ID);
        String fromUserId = intent.getStringExtra(EXTRA_FROM_USER_ID);
        String title = intent.getStringExtra(EXTRA_TITLE);
        String body = intent.getStringExtra(EXTRA_BODY);
        boolean lockedAtStart = intent.getBooleanExtra(EXTRA_LOCKED_AT_START, isDeviceLocked());
        boolean autoAccept = intent.getBooleanExtra(EXTRA_AUTO_ACCEPT, false);
        boolean autoReject = intent.getBooleanExtra(EXTRA_AUTO_REJECT, false);
        String type = intent.getStringExtra(EXTRA_PUSH_TYPE);

        if (!callMode && (type == null || type.isEmpty()) && !autoAccept && !autoReject) {
            return;
        }

        Log.i(TAG, "MainActivity intent received mode=" + (callMode ? "call" : type)
            + " callId=" + callId + " accept=" + autoAccept + " reject=" + autoReject);

        if (callId != null && !callId.isEmpty()) {
            if (autoAccept) {
                CoachmanCallsPlugin.suppressIncomingUi(callId);
            }
            IncomingCallActivity.dismissActive(callId);
            IncomingCallRingService.dismissNow(this, callId);
        } else {
            IncomingCallRingService.dismissNow(this, null);
        }

        if (callMode || (callId != null && !callId.isEmpty() && chatId != null && !chatId.isEmpty())) {
            CallSessionStore.Session session = CallSessionStore.put(
                this,
                callId != null ? callId : "",
                chatId != null ? chatId : "",
                fromUserId != null ? fromUserId : "",
                title != null ? title : "Входящий видеозвонок",
                body != null ? body : "Собеседник",
                lockedAtStart
            );
            if (session != null) {
                enterCallOnlyMode(session, autoAccept, autoReject);
            }
        }

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
            if (autoReject) {
                closeCallOnlyMode(callId);
            }
        }

        intent.removeExtra(EXTRA_PUSH_TYPE);
        intent.removeExtra(EXTRA_MODE);
        intent.removeExtra(EXTRA_AUTO_ACCEPT);
        intent.removeExtra(EXTRA_AUTO_REJECT);
    }

    private static boolean isCallModeIntent(Intent intent) {
        if (intent == null) return false;
        if (MODE_CALL.equals(intent.getStringExtra(EXTRA_MODE))) return true;
        if (ACTION_INCOMING_CALL.equals(intent.getAction())) return true;
        if (IncomingCallRingService.ACTION_ACCEPT.equals(intent.getAction())) return true;
        if (IncomingCallRingService.ACTION_DECLINE.equals(intent.getAction())) return true;
        Uri data = intent.getData();
        return data != null && "coachman".equals(data.getScheme())
            && "incoming-call".equals(data.getHost());
    }

    private boolean isDeviceLocked() {
        try {
            KeyguardManager km = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
            return km != null && km.isDeviceLocked();
        } catch (Exception e) {
            return false;
        }
    }

    public interface FinishCallback {
        void onDone(boolean unlocked);
    }
}
