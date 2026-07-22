package com.coachman.app.calls;

import android.content.Context;
import android.util.Log;

import com.coachman.app.calls.nativewebrtc.NativeCallAuthStore;
import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Registers the FCM device token with the Coachman API using the JWT from
 * {@link NativeCallAuthStore}. Independent of the WebView/JS bridge so closed-app
 * incoming calls work even when JS registration races auth.
 */
public final class DeviceTokenRegistrar {
    private static final String TAG = "DeviceTokenReg";
    private static final ExecutorService EXEC = Executors.newSingleThreadExecutor();
    private static final AtomicBoolean inFlight = new AtomicBoolean(false);
    private static volatile String lastRegisteredToken = "";

    private DeviceTokenRegistrar() {}

    public static void syncFromAuthStore(Context context) {
        Context app = context.getApplicationContext();
        EXEC.execute(() -> {
            NativeCallAuthStore.Creds creds = NativeCallAuthStore.peek(app);
            if (creds == null) {
                Log.w(TAG, "skip register — no native auth");
                return;
            }
            try {
                FirebaseMessaging.getInstance().getToken()
                    .addOnSuccessListener(token -> EXEC.execute(() -> register(app, creds, token)))
                    .addOnFailureListener(e -> Log.e(TAG, "FCM getToken failed", e));
            } catch (Exception e) {
                Log.e(TAG, "FCM getToken threw", e);
            }
        });
    }

    public static void syncWithToken(Context context, String fcmToken) {
        if (fcmToken == null || fcmToken.isEmpty()) return;
        Context app = context.getApplicationContext();
        EXEC.execute(() -> {
            NativeCallAuthStore.Creds creds = NativeCallAuthStore.peek(app);
            if (creds == null) {
                Log.w(TAG, "skip register — no native auth (token len=" + fcmToken.length() + ")");
                return;
            }
            register(app, creds, fcmToken);
        });
    }

    private static void register(Context app, NativeCallAuthStore.Creds creds, String fcmToken) {
        if (fcmToken == null || fcmToken.isEmpty()) return;
        if (fcmToken.equals(lastRegisteredToken)) {
            Log.i(TAG, "already registered token tail=…" + tail(fcmToken));
            return;
        }
        try {
            java.io.File f = new java.io.File(app.getFilesDir(), "fcm_device_token.txt");
            java.io.FileOutputStream out = new java.io.FileOutputStream(f);
            out.write(fcmToken.getBytes(StandardCharsets.UTF_8));
            out.close();
        } catch (Exception ignored) {
        }
        if (!inFlight.compareAndSet(false, true)) return;
        HttpURLConnection conn = null;
        try {
            String base = creds.baseUrl.endsWith("/") ? creds.baseUrl : creds.baseUrl + "/";
            URL url = new URL(base + "api/push/device-token");
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(15_000);
            conn.setReadTimeout(15_000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Authorization", "Bearer " + creds.accessToken);

            JSONObject body = new JSONObject();
            body.put("token", fcmToken);
            body.put("platform", "android");
            body.put("nativeVideoCall", true);
            body.put("nativeCallProtocol", 1);
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(bytes);
            }

            int code = conn.getResponseCode();
            if (code >= 200 && code < 300) {
                lastRegisteredToken = fcmToken;
                Log.i(TAG, "FCM_DEVICE_TOKEN_REGISTERED userId=" + creds.userId
                    + " tail=…" + tail(fcmToken) + " status=" + code);
            } else {
                Log.w(TAG, "FCM_DEVICE_TOKEN_REGISTER_FAILED status=" + code
                    + " userId=" + creds.userId + " tail=…" + tail(fcmToken));
            }
        } catch (Exception e) {
            Log.e(TAG, "FCM_DEVICE_TOKEN_REGISTER_ERROR", e);
        } finally {
            inFlight.set(false);
            if (conn != null) conn.disconnect();
        }
    }

    private static String tail(String token) {
        if (token.length() <= 8) return token;
        return token.substring(token.length() - 8);
    }
}
