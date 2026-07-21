package com.coachman.app.calls;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.coachman.app.MainActivity;
import com.getcapacitor.JSObject;

/**
 * Handles CallStyle Accept / Decline. Must clear the foreground-service notification
 * immediately — {@code NotificationManager.cancel} alone often leaves the heads-up
 * chip on screen while {@link IncomingCallRingService} is still running.
 */
public class IncomingCallActionReceiver extends BroadcastReceiver {
    private static final String TAG = "IncomingCallAction";

    public static final String ACTION_ACCEPT = IncomingCallRingService.ACTION_ACCEPT;
    public static final String ACTION_DECLINE = IncomingCallRingService.ACTION_DECLINE;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        if (!ACTION_ACCEPT.equals(action) && !ACTION_DECLINE.equals(action)) return;

        String callId = safe(intent.getStringExtra(IncomingCallRingService.EXTRA_CALL_ID));
        String chatId = safe(intent.getStringExtra(IncomingCallRingService.EXTRA_CHAT_ID));
        String fromUserId = safe(intent.getStringExtra(IncomingCallRingService.EXTRA_FROM_USER_ID));
        boolean accept = ACTION_ACCEPT.equals(action);

        Log.i(TAG, "call action=" + (accept ? "accept" : "decline") + " callId=" + callId);

        // Tear down CallStyle / FGS first so the popup disappears before MainActivity paints.
        IncomingCallRingService.dismissNow(context, callId);
        IncomingCallActivity.dismissActive(callId);

        if (accept) {
            CoachmanCallsPlugin.suppressIncomingUi(callId);
        }

        JSObject data = new JSObject();
        data.put("type", "incoming-call");
        data.put("callId", callId);
        data.put("chatId", chatId);
        data.put("fromUserId", fromUserId);
        data.put(accept ? "autoAccept" : "autoReject", "true");
        CoachmanCallsPlugin.queueLaunchCall(data);

        Intent open = new Intent(context, MainActivity.class);
        open.addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
        );
        open.putExtra("coachman_push_type", "incoming-call");
        open.putExtra("coachman_call_id", callId);
        open.putExtra("coachman_chat_id", chatId);
        open.putExtra("coachman_from_user_id", fromUserId);
        open.putExtra("coachman_auto_accept", accept);
        open.putExtra("coachman_auto_reject", !accept);
        try {
            context.startActivity(open);
        } catch (Exception e) {
            Log.e(TAG, "start MainActivity failed", e);
        }
    }

    private static String safe(String v) {
        return v == null ? "" : v;
    }
}
