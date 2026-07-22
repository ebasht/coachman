package com.coachman.app.calls;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import com.getcapacitor.JSObject;

import org.json.JSONObject;

/**
 * Durable call-only launch context (survives process death until React is ready).
 * Complements {@link CallActionStore} which stores Accept/Reject taps.
 */
public final class CallSessionStore {
    private static final String TAG = "CallSessionStore";
    private static final String PREFS = "coachman_call_session";
    private static final String KEY_SESSION = "session_json";
    public static final long TTL_MS = 90_000L;

    private static final Object LOCK = new Object();

    private CallSessionStore() {}

    public static final class Session {
        public final String callId;
        public final String chatId;
        public final String fromUserId;
        public final String title;
        public final String body;
        public final boolean lockedAtStart;
        public final long createdAt;

        public Session(
            String callId,
            String chatId,
            String fromUserId,
            String title,
            String body,
            boolean lockedAtStart,
            long createdAt
        ) {
            this.callId = callId == null ? "" : callId;
            this.chatId = chatId == null ? "" : chatId;
            this.fromUserId = fromUserId == null ? "" : fromUserId;
            this.title = title == null ? "" : title;
            this.body = body == null ? "" : body;
            this.lockedAtStart = lockedAtStart;
            this.createdAt = createdAt;
        }

        public boolean isExpired(long nowMs) {
            return createdAt <= 0 || nowMs - createdAt > TTL_MS;
        }

        public JSObject toJsObject() {
            JSObject o = new JSObject();
            o.put("active", true);
            o.put("callId", callId);
            o.put("chatId", chatId);
            o.put("fromUserId", fromUserId);
            o.put("title", title);
            o.put("body", body);
            o.put("lockedAtStart", lockedAtStart);
            o.put("createdAt", createdAt);
            return o;
        }
    }

    public static Session put(
        Context context,
        String callId,
        String chatId,
        String fromUserId,
        String title,
        String body,
        boolean lockedAtStart
    ) {
        if (context == null || callId == null || callId.isEmpty() || chatId == null || chatId.isEmpty()) {
            return null;
        }
        synchronized (LOCK) {
            long now = System.currentTimeMillis();
            Session existing = readUnlocked(context);
            if (existing != null && !existing.isExpired(now) && callId.equals(existing.callId)) {
                Log.i(TAG, "session keep existing callId=" + callId);
                return existing;
            }
            Session next = new Session(
                callId,
                chatId,
                fromUserId,
                title,
                body,
                lockedAtStart,
                now
            );
            writeUnlocked(context, next);
            Log.i(TAG, "session persisted callId=" + callId);
            return next;
        }
    }

    public static Session peek(Context context) {
        if (context == null) return null;
        synchronized (LOCK) {
            Session s = readUnlocked(context);
            if (s == null) return null;
            if (s.isExpired(System.currentTimeMillis())) {
                Log.i(TAG, "session expired callId=" + s.callId);
                clearUnlocked(context);
                return null;
            }
            return s;
        }
    }

    public static void clear(Context context) {
        if (context == null) return;
        synchronized (LOCK) {
            clearUnlocked(context);
            Log.i(TAG, "session cleared");
        }
    }

    public static void clearIfCall(Context context, String callId) {
        if (context == null) return;
        synchronized (LOCK) {
            Session s = readUnlocked(context);
            if (s == null) return;
            if (callId == null || callId.isEmpty() || callId.equals(s.callId)) {
                clearUnlocked(context);
                Log.i(TAG, "session cleared callId=" + (s.callId));
            }
        }
    }

    private static Session readUnlocked(Context context) {
        SharedPreferences prefs = context.getApplicationContext()
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String raw = prefs.getString(KEY_SESSION, null);
        if (raw == null || raw.isEmpty()) return null;
        try {
            JSONObject o = new JSONObject(raw);
            return new Session(
                o.optString("callId", ""),
                o.optString("chatId", ""),
                o.optString("fromUserId", ""),
                o.optString("title", ""),
                o.optString("body", ""),
                o.optBoolean("lockedAtStart", false),
                o.optLong("createdAt", 0L)
            );
        } catch (Exception e) {
            Log.w(TAG, "read failed", e);
            return null;
        }
    }

    private static void writeUnlocked(Context context, Session session) {
        try {
            JSONObject o = new JSONObject();
            o.put("callId", session.callId);
            o.put("chatId", session.chatId);
            o.put("fromUserId", session.fromUserId);
            o.put("title", session.title);
            o.put("body", session.body);
            o.put("lockedAtStart", session.lockedAtStart);
            o.put("createdAt", session.createdAt);
            context.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_SESSION, o.toString())
                .commit();
        } catch (Exception e) {
            Log.e(TAG, "write failed", e);
        }
    }

    private static void clearUnlocked(Context context) {
        context.getApplicationContext()
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_SESSION)
            .commit();
    }
}
