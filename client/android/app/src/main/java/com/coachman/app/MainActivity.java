package com.coachman.app;

import android.content.Intent;
import android.os.Bundle;

import com.coachman.app.calls.CoachmanCallsPlugin;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSObject;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CoachmanCallsPlugin.class);
        super.onCreate(savedInstanceState);
        deliverCallIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        deliverCallIntent(intent);
    }

    private void deliverCallIntent(Intent intent) {
        if (intent == null) return;
        String type = intent.getStringExtra("coachman_push_type");
        if (type == null || type.isEmpty()) return;
        JSObject data = new JSObject();
        data.put("type", type);
        String callId = intent.getStringExtra("coachman_call_id");
        String chatId = intent.getStringExtra("coachman_chat_id");
        String fromUserId = intent.getStringExtra("coachman_from_user_id");
        if (callId != null) data.put("callId", callId);
        if (chatId != null) data.put("chatId", chatId);
        if (fromUserId != null) data.put("fromUserId", fromUserId);
        CoachmanCallsPlugin.queueLaunchCall(data);
        intent.removeExtra("coachman_push_type");
    }
}
