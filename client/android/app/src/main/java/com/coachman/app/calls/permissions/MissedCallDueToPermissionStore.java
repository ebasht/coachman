package com.coachman.app.calls.permissions;

import android.content.Context;
import android.content.SharedPreferences;

/** Remembers that an incoming call was missed due to missing permissions. */
public final class MissedCallDueToPermissionStore {
    private static final String PREFS = "coachman_missed_call_perm";

    private MissedCallDueToPermissionStore() {}

    public static void mark(Context context, String callId, String reason) {
        prefs(context).edit()
            .putString("callId", callId == null ? "" : callId)
            .putString("reason", reason == null ? "" : reason)
            .putLong("at", System.currentTimeMillis())
            .apply();
    }

    public static String peekReason(Context context) {
        return prefs(context).getString("reason", "");
    }

    public static void clear(Context context) {
        prefs(context).edit().clear().apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
