package com.coachman.app.calls.nativewebrtc;

import android.content.Context;
import android.content.SharedPreferences;

/** Durable ringing/session metadata only — never SDP/ICE/media. */
public final class NativeCallSessionStore {
    private static final String PREFS = "coachman_native_call_session";
    private static final long RING_TTL_MS = 45_000L;

    public enum State {
        RINGING,
        PREVIEW_CONNECTING,
        PREVIEW_VISIBLE,
        ANSWERING,
        ACTIVE_CONNECTING,
        ACTIVE,
        ENDING,
        ENDED,
        FAILED
    }

    public static final class Session {
        public final String callId;
        public final String chatId;
        public final String fromUserId;
        public final String callerName;
        public final String callerAvatarUrl;
        public final State state;
        public final boolean accepted;
        public final long createdAt;
        public final long expiresAt;
        public final int protocolVersion;

        public Session(
            String callId,
            String chatId,
            String fromUserId,
            String callerName,
            String callerAvatarUrl,
            State state,
            boolean accepted,
            long createdAt,
            long expiresAt,
            int protocolVersion
        ) {
            this.callId = callId;
            this.chatId = chatId;
            this.fromUserId = fromUserId;
            this.callerName = callerName;
            this.callerAvatarUrl = callerAvatarUrl;
            this.state = state;
            this.accepted = accepted;
            this.createdAt = createdAt;
            this.expiresAt = expiresAt;
            this.protocolVersion = protocolVersion;
        }

        public boolean isExpired(long now) {
            return now > expiresAt && !accepted;
        }

        /** Still in an in-progress call (ringing or connected) — UI should return here. */
        public boolean isLive() {
            return state != State.ENDING && state != State.ENDED && state != State.FAILED;
        }
    }

    private NativeCallSessionStore() {}

    public static void put(
        Context context,
        String callId,
        String chatId,
        String fromUserId,
        String callerName,
        String callerAvatarUrl,
        State state,
        boolean accepted,
        int protocolVersion
    ) {
        long now = System.currentTimeMillis();
        prefs(context).edit()
            .putString("callId", callId)
            .putString("chatId", chatId)
            .putString("fromUserId", fromUserId == null ? "" : fromUserId)
            .putString("callerName", callerName == null ? "" : callerName)
            .putString("callerAvatarUrl", callerAvatarUrl == null ? "" : callerAvatarUrl)
            .putString("state", state.name())
            .putBoolean("accepted", accepted)
            .putLong("createdAt", now)
            .putLong("expiresAt", now + RING_TTL_MS)
            .putInt("protocolVersion", protocolVersion)
            .apply();
    }

    public static void updateState(Context context, State state, boolean accepted) {
        Session s = peek(context);
        if (s == null) return;
        prefs(context).edit()
            .putString("state", state.name())
            .putBoolean("accepted", accepted || s.accepted)
            .apply();
    }

    public static Session peek(Context context) {
        SharedPreferences p = prefs(context);
        String callId = p.getString("callId", "");
        if (callId == null || callId.isEmpty()) return null;
        long now = System.currentTimeMillis();
        long expiresAt = p.getLong("expiresAt", 0);
        boolean accepted = p.getBoolean("accepted", false);
        if (!accepted && now > expiresAt) {
            clear(context);
            return null;
        }
        State state;
        try {
            state = State.valueOf(p.getString("state", State.RINGING.name()));
        } catch (Exception e) {
            state = State.RINGING;
        }
        return new Session(
            callId,
            p.getString("chatId", ""),
            p.getString("fromUserId", ""),
            p.getString("callerName", ""),
            p.getString("callerAvatarUrl", ""),
            state,
            accepted,
            p.getLong("createdAt", 0),
            expiresAt,
            p.getInt("protocolVersion", 1)
        );
    }

    public static void clearIfCall(Context context, String callId) {
        Session s = peek(context);
        if (s == null) return;
        if (callId != null && !callId.isEmpty() && !callId.equals(s.callId)) return;
        clear(context);
    }

    public static void clear(Context context) {
        prefs(context).edit().clear().apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
