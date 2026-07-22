package com.coachman.app.calls;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Debug / QA wake for incoming-call path without waiting for FCM.
 * adb shell am broadcast -a com.coachman.app.DEBUG_INCOMING_CALL -n com.coachman.app/.calls.IncomingCallDebugReceiver
 */
public class IncomingCallDebugReceiver extends BroadcastReceiver {
    private static final String TAG = "IncomingCallDebug";
    public static final String ACTION = "com.coachman.app.DEBUG_INCOMING_CALL";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION.equals(intent.getAction())) return;
        String callId = intent.getStringExtra("callId");
        if (callId == null || callId.isEmpty()) {
            callId = "debug-" + System.currentTimeMillis();
        }
        String chatId = intent.getStringExtra("chatId");
        if (chatId == null || chatId.isEmpty()) chatId = "debug-chat";
        String title = intent.getStringExtra("title");
        if (title == null || title.isEmpty()) title = "Входящий видеозвонок";
        String body = intent.getStringExtra("body");
        if (body == null || body.isEmpty()) body = "Debug";
        Log.i(TAG, "DEBUG_INCOMING_CALL callId=" + callId);
        CoachmanCallsPlugin.presentIncomingCallNative(
            context.getApplicationContext(),
            callId,
            chatId,
            intent.getStringExtra("fromUserId") != null ? intent.getStringExtra("fromUserId") : "debug",
            title,
            body
        );
    }
}
