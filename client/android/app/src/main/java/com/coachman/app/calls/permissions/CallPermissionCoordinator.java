package com.coachman.app.calls.permissions;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;

import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

/**
 * Single source of truth for call permission checks and settings Intents.
 * Does not request permissions itself — callers use Activity Result / Capacitor aliases.
 */
public final class CallPermissionCoordinator {
    private static final String TAG = "CallPermission";

    /** Fresh channel — old IDs may be stuck at low importance on device. */
    public static final String CALL_CHANNEL_ID = "coachman_incoming_calls_v3";
    public static final String CALL_CHANNEL_NAME = "Входящие звонки";

    private CallPermissionCoordinator() {}

    public static boolean requiresPostNotifications(int sdkInt) {
        return sdkInt >= Build.VERSION_CODES.TIRAMISU;
    }

    public static boolean requiresBluetoothConnect(int sdkInt) {
        return sdkInt >= Build.VERSION_CODES.S;
    }

    public static boolean supportsFullScreenSpecialAccess(int sdkInt) {
        return sdkInt >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE;
    }

    public static CallPermissionState evaluate(Context context) {
        CallPermissionState s = new CallPermissionState();
        int sdk = Build.VERSION.SDK_INT;
        s.sdkInt = sdk;
        s.manufacturer = Build.MANUFACTURER != null ? Build.MANUFACTURER : "";
        s.model = Build.MODEL != null ? Build.MODEL : "";
        s.applicationId = context.getPackageName();
        s.callChannelId = CALL_CHANNEL_ID;

        s.appNotificationsEnabled = NotificationManagerCompat.from(context).areNotificationsEnabled();
        if (requiresPostNotifications(sdk)) {
            s.notificationsGranted = ContextCompat.checkSelfPermission(
                context, Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED;
        } else {
            s.notificationsGranted = true;
        }

        s.cameraGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED;
        s.microphoneGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED;

        s.bluetoothRequired = requiresBluetoothConnect(sdk);
        if (s.bluetoothRequired) {
            s.bluetoothGranted = ContextCompat.checkSelfPermission(
                context, Manifest.permission.BLUETOOTH_CONNECT
            ) == PackageManager.PERMISSION_GRANTED;
        } else {
            s.bluetoothGranted = true;
        }

        s.fullScreenSupported = true;
        if (supportsFullScreenSpecialAccess(sdk)) {
            NotificationManager nm = context.getSystemService(NotificationManager.class);
            s.fullScreenAllowed = nm != null && nm.canUseFullScreenIntent();
        } else {
            s.fullScreenAllowed = true;
        }

        ensureCallChannel(context);
        readChannelState(context, s);

        s.batteryOptimized = isBatteryOptimized(context);

        boolean bluetoothOk = !s.bluetoothRequired || s.bluetoothGranted;
        s.requiredRuntimePermissionsGranted =
            s.notificationsGranted
                && s.cameraGranted
                && s.microphoneGranted
                && bluetoothOk;

        s.incomingCallsReady =
            s.notificationsGranted
                && s.appNotificationsEnabled
                && s.callChannelHighImportance
                && s.fullScreenAllowed;

        s.activeVideoCallsReady =
            s.incomingCallsReady
                && s.cameraGranted
                && s.microphoneGranted
                && bluetoothOk;

        Log.i(TAG, "CALL_PERMISSION_STATE"
            + " notifications=" + s.notificationsGranted
            + " appNotif=" + s.appNotificationsEnabled
            + " channelHigh=" + s.callChannelHighImportance
            + " channelImportance=" + s.callChannelImportance
            + " fsi=" + s.fullScreenAllowed
            + " camera=" + s.cameraGranted
            + " mic=" + s.microphoneGranted
            + " bt=" + s.bluetoothGranted
            + " incomingReady=" + s.incomingCallsReady
            + " activeReady=" + s.activeVideoCallsReady
            + " batteryOpt=" + s.batteryOptimized
        );

        return s;
    }

    public static void ensureCallChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (nm.getNotificationChannel(CALL_CHANNEL_ID) != null) return;

        NotificationChannel channel = new NotificationChannel(
            CALL_CHANNEL_ID,
            CALL_CHANNEL_NAME,
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Полноэкранные уведомления о входящих звонках");
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        channel.enableVibration(true);
        channel.enableLights(true);
        channel.setSound(null, null);
        channel.setBypassDnd(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            channel.setAllowBubbles(true);
        }
        nm.createNotificationChannel(channel);
        Log.i(TAG, "CALL_CHANNEL_CREATED id=" + CALL_CHANNEL_ID);
    }

    private static void readChannelState(Context context, CallPermissionState s) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            s.callChannelExists = true;
            s.callChannelHighImportance = true;
            s.callChannelImportance = NotificationManager.IMPORTANCE_HIGH;
            return;
        }
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel actual = nm.getNotificationChannel(CALL_CHANNEL_ID);
        s.callChannelExists = actual != null;
        if (actual != null) {
            s.callChannelImportance = actual.getImportance();
            s.callChannelHighImportance =
                actual.getImportance() >= NotificationManager.IMPORTANCE_HIGH;
            Log.i(TAG, "CALL_CHANNEL_ACTUAL_IMPORTANCE importance=" + actual.getImportance());
        } else {
            s.callChannelImportance = NotificationManager.IMPORTANCE_NONE;
            s.callChannelHighImportance = false;
        }
    }

    public static boolean isBatteryOptimized(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return false;
        PowerManager pm = context.getSystemService(PowerManager.class);
        if (pm == null) return false;
        return !pm.isIgnoringBatteryOptimizations(context.getPackageName());
    }

    public static Intent createFullScreenIntentSettings(Context context) {
        Intent intent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT);
        intent.setData(Uri.parse("package:" + context.getPackageName()));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return intent;
    }

    public static Intent createAppDetailsSettings(Context context) {
        Intent intent = new Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:" + context.getPackageName())
        );
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return intent;
    }

    public static Intent createNotificationSettings(Context context) {
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
        intent.putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return intent;
    }

    public static Intent createCallChannelSettings(Context context) {
        Intent intent = new Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS);
        intent.putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
        intent.putExtra(Settings.EXTRA_CHANNEL_ID, CALL_CHANNEL_ID);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return intent;
    }

    public static Intent createBatterySettings(Context context) {
        // Safe: app details — user can open Battery from there on Samsung.
        return createAppDetailsSettings(context);
    }

    public static boolean openFullScreenCallSettings(Context context) {
        Log.i(TAG, "FULL_SCREEN_SETTINGS_OPENED");
        try {
            if (supportsFullScreenSpecialAccess(Build.VERSION.SDK_INT)) {
                context.startActivity(createFullScreenIntentSettings(context));
                return true;
            }
            context.startActivity(createNotificationSettings(context));
            return true;
        } catch (ActivityNotFoundException e) {
            try {
                context.startActivity(createAppDetailsSettings(context));
                return true;
            } catch (Exception ignored) {
                return false;
            }
        } catch (Exception e) {
            try {
                context.startActivity(createAppDetailsSettings(context));
                return true;
            } catch (Exception ignored) {
                return false;
            }
        }
    }

    public static boolean openNotificationSettings(Context context) {
        try {
            context.startActivity(createNotificationSettings(context));
            return true;
        } catch (Exception e) {
            try {
                context.startActivity(createAppDetailsSettings(context));
                return true;
            } catch (Exception ignored) {
                return false;
            }
        }
    }

    public static boolean openCallChannelSettings(Context context) {
        Log.i(TAG, "CALL_CHANNEL_SETTINGS_OPENED");
        ensureCallChannel(context);
        try {
            context.startActivity(createCallChannelSettings(context));
            return true;
        } catch (Exception e) {
            return openNotificationSettings(context);
        }
    }

    public static boolean openAppSettings(Context context) {
        try {
            context.startActivity(createAppDetailsSettings(context));
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    public static boolean openBatterySettings(Context context) {
        try {
            context.startActivity(createBatterySettings(context));
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** True when it is safe to present CallStyle / FSI notification. */
    public static boolean canPresentIncomingNotification(Context context) {
        CallPermissionState s = evaluate(context);
        return s.notificationsGranted && s.appNotificationsEnabled;
    }

    /** Direct startActivity bypass is forbidden when FSI is denied. */
    public static boolean mayLaunchIncomingActivityDirectly(Context context) {
        CallPermissionState s = evaluate(context);
        return s.incomingCallsReady;
    }

    public static void openAppSettingsFromActivity(Activity activity) {
        Intent intent = createAppDetailsSettings(activity);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        activity.startActivity(intent);
    }
}
