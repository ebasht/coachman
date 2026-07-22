package com.coachman.app.calls;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

/** Resolves the Capacitor/PWA origin used by the lock-screen call WebView. */
public final class CallServerUrl {
    private static final String TAG = "CallServerUrl";
    private static final String DEFAULT = "https://coachman.eugen-bash.com/";

    private CallServerUrl() {}

    public static String resolve(Context context) {
        String fromAssets = readFromCapacitorConfig(context);
        if (fromAssets != null && !fromAssets.isEmpty()) {
            return ensureTrailingSlash(fromAssets);
        }
        try {
            String build = com.coachman.app.BuildConfig.CAP_SERVER_URL;
            if (build != null && !build.isEmpty()) {
                return ensureTrailingSlash(build);
            }
        } catch (Throwable ignored) {
        }
        return DEFAULT;
    }

    private static String readFromCapacitorConfig(Context context) {
        try {
            AssetManager am = context.getAssets();
            InputStream in = am.open("capacitor.config.json");
            BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) sb.append(line);
            reader.close();
            JSONObject root = new JSONObject(sb.toString());
            JSONObject server = root.optJSONObject("server");
            if (server == null) return null;
            String url = server.optString("url", "");
            return url.isEmpty() ? null : url;
        } catch (Exception e) {
            Log.i(TAG, "capacitor.config.json not readable, using default");
            return null;
        }
    }

    private static String ensureTrailingSlash(String url) {
        return url.endsWith("/") ? url : url + "/";
    }
}
