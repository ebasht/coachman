package com.coachman.app.calls.nativewebrtc;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

/**
 * Call-only credentials for native signaling. Never stores passphrase or E2E keys.
 * TODO(server): prefer a scoped call-signaling token instead of full JWT.
 */
public final class NativeCallAuthStore {
    private static final String TAG = "NativeCallAuth";
    private static final String PREFS = "coachman_native_call_auth";

    public static final class Creds {
        public final String baseUrl;
        public final String accessToken;
        public final String userId;

        public Creds(String baseUrl, String accessToken, String userId) {
            this.baseUrl = baseUrl;
            this.accessToken = accessToken;
            this.userId = userId;
        }
    }

    private NativeCallAuthStore() {}

    public static void save(Context context, String baseUrl, String accessToken, String userId) {
        try {
            prefs(context).edit()
                .putString("baseUrl", trimSlash(baseUrl))
                .putString("accessToken", accessToken == null ? "" : accessToken)
                .putString("userId", userId == null ? "" : userId)
                .apply();
            NativeCallLogger.i("NATIVE_AUTH_SAVED", userId);
        } catch (Exception e) {
            Log.e(TAG, "save failed", e);
        }
    }

    public static Creds peek(Context context) {
        try {
            SharedPreferences p = prefs(context);
            String baseUrl = p.getString("baseUrl", "");
            String token = p.getString("accessToken", "");
            String userId = p.getString("userId", "");
            if (baseUrl == null || baseUrl.isEmpty() || token == null || token.isEmpty() || userId == null || userId.isEmpty()) {
                return null;
            }
            return new Creds(baseUrl, token, userId);
        } catch (Exception e) {
            Log.e(TAG, "peek failed", e);
            return null;
        }
    }

    public static void clear(Context context) {
        try {
            prefs(context).edit().clear().apply();
            NativeCallLogger.i("NATIVE_AUTH_CLEARED", "");
        } catch (Exception e) {
            Log.e(TAG, "clear failed", e);
        }
    }

    private static String trimSlash(String url) {
        if (url == null) return "";
        return url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
    }

    private static SharedPreferences prefs(Context context) throws Exception {
        Context app = context.getApplicationContext();
        MasterKey key = new MasterKey.Builder(app)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build();
        return EncryptedSharedPreferences.create(
            app,
            PREFS,
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        );
    }
}
