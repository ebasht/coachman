package com.coachman.app.calls;

import android.app.AppOpsManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Process;
import android.provider.Settings;
import android.util.Log;

/**
 * Xiaomi / Redmi / POCO (MIUI, HyperOS) block lock-screen call UI unless the user
 * grants OEM "Show on lock screen" and often "Display pop-up while in background".
 */
public final class OemLockScreenHelper {
    private static final String TAG = "OemLockScreen";
    /** MIUI AppOps: show on lock screen */
    private static final int OP_SHOW_WHEN_LOCKED = 10020;
    /** MIUI AppOps: start activity from background / pop-up while background */
    private static final int OP_BACKGROUND_START_ACTIVITY = 10021;

    private OemLockScreenHelper() {}

    public static boolean isXiaomiFamily() {
        String m = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
        String b = Build.BRAND == null ? "" : Build.BRAND;
        String finger = (m + " " + b).toLowerCase();
        return finger.contains("xiaomi")
            || finger.contains("redmi")
            || finger.contains("poco")
            || finger.contains("blackshark");
    }

    public static boolean needsOemLockScreenSetup(Context context) {
        if (!isXiaomiFamily()) return false;
        return !isMiuiOpAllowed(context, OP_SHOW_WHEN_LOCKED)
            || !isMiuiOpAllowed(context, OP_BACKGROUND_START_ACTIVITY);
    }

    public static boolean isMiuiOpAllowed(Context context, int op) {
        try {
            AppOpsManager manager = (AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
            if (manager == null) return true;
            java.lang.reflect.Method method = AppOpsManager.class.getDeclaredMethod(
                "checkOpNoThrow",
                int.class,
                int.class,
                String.class
            );
            int result = (int) method.invoke(
                manager,
                op,
                Process.myUid(),
                context.getPackageName()
            );
            return result == AppOpsManager.MODE_ALLOWED;
        } catch (Exception e) {
            // Op unreadable → treat as needing setup on Xiaomi so we still guide the user.
            Log.w(TAG, "checkOp " + op + " failed", e);
            return !isXiaomiFamily();
        }
    }

    /** Opens MIUI "Other permissions" (Show on lock screen / background pop-ups). */
    public static boolean openOemCallPermissions(Context context) {
        if (openMiuiPermEditor(context)) return true;
        if (openMiuiAppPermissions(context)) return true;
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "open app details failed", e);
            return false;
        }
    }

    private static boolean openMiuiPermEditor(Context context) {
        try {
            Intent intent = new Intent("miui.intent.action.APP_PERM_EDITOR");
            intent.setClassName(
                "com.miui.securitycenter",
                "com.miui.permcenter.permissions.PermissionsEditorActivity"
            );
            intent.putExtra("extra_pkgname", context.getPackageName());
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "MIUI PermissionsEditorActivity failed", e);
            return false;
        }
    }

    private static boolean openMiuiAppPermissions(Context context) {
        try {
            Intent intent = new Intent("miui.intent.action.APP_PERM_EDITOR");
            intent.setClassName(
                "com.miui.securitycenter",
                "com.miui.permcenter.permissions.AppPermissionsEditorActivity"
            );
            intent.putExtra("extra_pkgname", context.getPackageName());
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "MIUI AppPermissionsEditorActivity failed", e);
            return false;
        }
    }
}
