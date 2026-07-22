package com.coachman.app.calls.nativewebrtc;

import android.util.Log;

/** Structured native-call logs — never log SDP, JWT, or ICE credentials. */
public final class NativeCallLogger {
    private static final String TAG = "NativeCall";

    private NativeCallLogger() {}

    public static void i(String event, String callId) {
        Log.i(TAG, event + " callId=" + safe(callId));
    }

    public static void i(String event, String callId, String detail) {
        Log.i(TAG, event + " callId=" + safe(callId) + " " + safe(detail));
    }

    public static void w(String event, String callId, Throwable t) {
        Log.w(TAG, event + " callId=" + safe(callId), t);
    }

    public static void e(String event, String callId, Throwable t) {
        Log.e(TAG, event + " callId=" + safe(callId), t);
    }

    private static String safe(String s) {
        return s == null ? "" : s;
    }
}
