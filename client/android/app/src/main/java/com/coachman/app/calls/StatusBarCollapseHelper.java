package com.coachman.app.calls;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.lang.reflect.Method;

/**
 * Best-effort collapse of the notification shade.
 * On Xiaomi/Poco/MIUI an open shade often sits above a freshly launched call
 * activity until the user dismisses it manually.
 *
 * Uses hidden StatusBarManager.collapsePanels() — works without the system
 * STATUS_BAR permission on most OEM builds; fails silently otherwise.
 */
public final class StatusBarCollapseHelper {
    private static final String TAG = "StatusBarCollapse";
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private StatusBarCollapseHelper() {}

    public static void collapse(Context context) {
        if (context == null) return;
        Context app = context.getApplicationContext();
        collapseOnce(app);
        // MIUI sometimes ignores the first call while the shade is animating.
        MAIN.postDelayed(() -> collapseOnce(app), 120);
        MAIN.postDelayed(() -> collapseOnce(app), 400);
    }

    private static void collapseOnce(Context context) {
        try {
            Object statusBar = context.getSystemService("statusbar");
            if (statusBar == null) return;
            Method collapse = statusBar.getClass().getMethod("collapsePanels");
            collapse.invoke(statusBar);
            Log.i(TAG, "collapsePanels invoked");
        } catch (Throwable t) {
            Log.d(TAG, "collapsePanels unavailable: " + t.getMessage());
        }
    }
}
