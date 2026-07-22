package com.coachman.app.calls;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import com.getcapacitor.JSObject;

import org.json.JSONObject;

import java.util.UUID;

/**
 * Durable store for Accept/Reject so the action survives process death between
 * the native tap and React/WebView becoming ready.
 */
public final class CallActionStore {
    private static final String TAG = "CallActionStore";
    private static final String PREFS = "coachman_call_actions";
    private static final String KEY_PENDING = "pending_json";
    /** Ignore / drop events older than this. */
    public static final long TTL_MS = 90_000L;

    private static final Object LOCK = new Object();

    private CallActionStore() {}

    public static final class PendingAction {
        public final String eventId;
        public final String type;
        public final String action;
        public final String callId;
        public final String chatId;
        public final String fromUserId;
        public final long createdAt;

        public PendingAction(
            String eventId,
            String type,
            String action,
            String callId,
            String chatId,
            String fromUserId,
            long createdAt
        ) {
            this.eventId = eventId == null ? "" : eventId;
            this.type = type == null ? "incoming-call" : type;
            this.action = action == null ? "" : action;
            this.callId = callId == null ? "" : callId;
            this.chatId = chatId == null ? "" : chatId;
            this.fromUserId = fromUserId == null ? "" : fromUserId;
            this.createdAt = createdAt;
        }

        public boolean isExpired(long nowMs) {
            return CallActionStore.isExpired(createdAt, nowMs);
        }

        public JSObject toJsObject() {
            JSObject o = new JSObject();
            o.put("eventId", eventId);
            o.put("type", type);
            o.put("action", action);
            o.put("callId", callId);
            o.put("chatId", chatId);
            o.put("fromUserId", fromUserId);
            o.put("createdAt", createdAt);
            // Compat flags for existing React handlers.
            if ("accept".equals(action)) {
                o.put("autoAccept", "true");
            } else if ("reject".equals(action)) {
                o.put("autoReject", "true");
            }
            return o;
        }
    }

    public static boolean isExpired(long createdAt, long nowMs) {
        return createdAt <= 0 || nowMs - createdAt > TTL_MS;
    }

    /**
     * Persist accept/reject. Same callId+action within TTL is a no-op (returns existing).
     */
    public static PendingAction put(
        Context context,
        String action,
        String callId,
        String chatId,
        String fromUserId
    ) {
        if (context == null) return null;
        String act = "accept".equals(action) ? "accept" : "reject".equals(action) ? "reject" : "";
        if (act.isEmpty() || callId == null || callId.isEmpty()) return null;

        synchronized (LOCK) {
            long now = System.currentTimeMillis();
            PendingAction existing = readUnlocked(context);
            if (existing != null && !existing.isExpired(now)
                && callId.equals(existing.callId) && act.equals(existing.action)) {
                Log.i(TAG, "persist skip duplicate callId=" + callId + " action=" + act
                    + " eventId=" + existing.eventId);
                return existing;
            }

            PendingAction next = new PendingAction(
                UUID.randomUUID().toString(),
                "incoming-call",
                act,
                callId,
                chatId != null ? chatId : "",
                fromUserId != null ? fromUserId : "",
                now
            );
            writeUnlocked(context, next);
            Log.i(TAG, "event persisted eventId=" + next.eventId + " callId=" + callId
                + " action=" + act);
            return next;
        }
    }

    /** Read without deleting. Expired rows are cleared. */
    public static PendingAction peek(Context context) {
        if (context == null) return null;
        synchronized (LOCK) {
            PendingAction pending = readUnlocked(context);
            if (pending == null) return null;
            if (pending.isExpired(System.currentTimeMillis())) {
                Log.i(TAG, "peek expired eventId=" + pending.eventId + " callId=" + pending.callId);
                clearUnlocked(context);
                return null;
            }
            return pending;
        }
    }

    /** Remove only if eventId matches the stored row. */
    public static boolean ack(Context context, String eventId) {
        if (context == null || eventId == null || eventId.isEmpty()) return false;
        synchronized (LOCK) {
            PendingAction pending = readUnlocked(context);
            if (pending == null) return false;
            if (!eventId.equals(pending.eventId)) {
                Log.w(TAG, "ack mismatch want=" + eventId + " have=" + pending.eventId);
                return false;
            }
            clearUnlocked(context);
            Log.i(TAG, "event acknowledged eventId=" + eventId + " callId=" + pending.callId);
            return true;
        }
    }

    public static void clear(Context context) {
        if (context == null) return;
        synchronized (LOCK) {
            clearUnlocked(context);
        }
    }

    private static PendingAction readUnlocked(Context context) {
        SharedPreferences prefs = context.getApplicationContext()
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String raw = prefs.getString(KEY_PENDING, null);
        if (raw == null || raw.isEmpty()) return null;
        try {
            JSONObject o = new JSONObject(raw);
            return new PendingAction(
                o.optString("eventId", ""),
                o.optString("type", "incoming-call"),
                o.optString("action", ""),
                o.optString("callId", ""),
                o.optString("chatId", ""),
                o.optString("fromUserId", ""),
                o.optLong("createdAt", 0L)
            );
        } catch (Exception e) {
            Log.w(TAG, "read failed", e);
            return null;
        }
    }

    private static void writeUnlocked(Context context, PendingAction action) {
        try {
            JSONObject o = new JSONObject();
            o.put("eventId", action.eventId);
            o.put("type", action.type);
            o.put("action", action.action);
            o.put("callId", action.callId);
            o.put("chatId", action.chatId);
            o.put("fromUserId", action.fromUserId);
            o.put("createdAt", action.createdAt);
            context.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_PENDING, o.toString())
                .commit();
        } catch (Exception e) {
            Log.e(TAG, "write failed", e);
        }
    }

    private static void clearUnlocked(Context context) {
        context.getApplicationContext()
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_PENDING)
            .commit();
    }
}
