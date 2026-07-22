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
                android.util.Log.i("CoachmanFCM", "FCM received type=incoming-call callId=" + callId);
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
                // Do not forward to Capacitor — avoids a second plain push tray item.
                return;
            } else if ("call-ended".equals(type)) {
                String callId = str(data.get("callId"));
                CoachmanCallsPlugin.dismissIncomingCallNative(getApplicationContext(), callId);
                return;
            } else if ("badge".equals(type)) {
                // Silent activity: update launcher badge even if WebView/JS is dead.
                int badge = parseBadge(data.get("badge"));
                if (badge > 0) {
                    CoachmanCallsPlugin.applyBadgeCount(getApplicationContext(), badge);
                }
                // Still forward so Capacitor/JS can bump in-chat unread when alive.
                super.onMessageReceived(remoteMessage);
                return;
            }
        }
        super.onMessageReceived(remoteMessage);
    }

    private static String str(String v) {
        return v == null ? "" : v;
    }

    private static int parseBadge(String raw) {
        if (raw == null || raw.isEmpty()) return 0;
        try {
            return Math.max(0, Integer.parseInt(raw.trim()));
        } catch (NumberFormatException e) {
            return 0;
        }
    }
}
