package com.coachman.app.calls;

import androidx.annotation.NonNull;

import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Intercepts FCM call wakes and shows the native full-screen incoming-call UI
 * even when the WebView/JS bridge is not running.
 */
public class CoachmanMessagingService extends MessagingService {
    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        Map<String, String> data = remoteMessage.getData();
        if (data != null) {
            String type = data.get("type");
            if ("incoming-call".equals(type)) {
                String callId = str(data.get("callId"));
                String chatId = str(data.get("chatId"));
                if (!callId.isEmpty() && !chatId.isEmpty()) {
                    String title = str(data.get("title"));
                    String body = str(data.get("body"));
                    if (title.isEmpty()) title = "Входящий видеозвонок";
                    if (body.isEmpty()) body = "Собеседник";
                    CoachmanCallsPlugin.presentIncomingCallNative(
                        getApplicationContext(),
                        callId,
                        chatId,
                        str(data.get("fromUserId")),
                        title,
                        body
                    );
                }
            } else if ("call-ended".equals(type)) {
                String callId = str(data.get("callId"));
                CoachmanCallsPlugin.dismissIncomingCallNative(getApplicationContext(), callId);
            }
        }
        super.onMessageReceived(remoteMessage);
    }

    private static String str(String v) {
        return v == null ? "" : v;
    }
}
