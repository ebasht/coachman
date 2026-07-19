package com.coachman.app.calls;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.service.notification.StatusBarNotification;
import android.util.Base64;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.coachman.app.MainActivity;
import com.coachman.app.R;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.OutputStream;

@CapacitorPlugin(
    name = "CoachmanCalls",
    permissions = {
        @Permission(
            alias = "media",
            strings = {
                Manifest.permission.CAMERA,
                Manifest.permission.RECORD_AUDIO
            }
        ),
        @Permission(
            alias = "notifications",
            strings = { Manifest.permission.POST_NOTIFICATIONS }
        ),
        @Permission(
            alias = "storage",
            strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }
        )
    }
)
public class CoachmanCallsPlugin extends Plugin {
    public static final String INCOMING_CHANNEL_ID = "incoming_calls_v4";
    public static final int INCOMING_NOTIFICATION_BASE = 42100;
    /** Silent tray item that drives launcher badge numbers on OEMs that count notifications. */
    public static final String BADGE_CHANNEL_ID = "app_badge";
    public static final int BADGE_NOTIFICATION_ID = 41999;

    private static JSObject pendingLaunchCall;
    private static CoachmanCallsPlugin instance;
    /** After Accept — ignore showIncomingCall until dismissed/ended. */
    private static volatile String suppressIncomingCallId;

    public static void queueLaunchCall(JSObject data) {
        pendingLaunchCall = data;
        if (instance != null) {
            instance.notifyListeners("callEvent", data);
        }
    }

    public static void suppressIncomingUi(String callId) {
        if (callId != null && !callId.isEmpty()) {
            suppressIncomingCallId = callId;
        }
    }

    public static void clearIncomingSuppress(String callId) {
        if (callId == null || callId.isEmpty() || callId.equals(suppressIncomingCallId)) {
            suppressIncomingCallId = null;
        }
    }

    /**
     * Show native full-screen ringing UI via a short foreground service.
     * Direct Activity starts from FCM are blocked on modern Android; the FGS
     * posts a CallStyle wake notification and launches {@link IncomingCallActivity}.
     */
    public static void presentIncomingCallNative(
        Context context,
        String callId,
        String chatId,
        String fromUserId,
        String title,
        String body
    ) {
        if (callId != null && callId.equals(suppressIncomingCallId)) {
            return;
        }
        ensureIncomingChannelStatic(context);
        IncomingCallRingService.start(context, callId, chatId, fromUserId, title, body);
    }

    public static void dismissIncomingCallNative(Context context, String callId) {
        IncomingCallActivity.dismissActive(callId);
        cancelIncomingNotification(context, callId);
        IncomingCallRingService.stop(context);
        // Empty callId = call ended / idle — allow future incoming UI.
        if (callId == null || callId.isEmpty()) {
            suppressIncomingCallId = null;
        }
    }

    public static void cancelIncomingNotification(Context context, String callId) {
        if (callId == null || callId.isEmpty()) return;
        int req = Math.abs(callId.hashCode()) & 0xffff;
        NotificationManagerCompat.from(context).cancel(INCOMING_NOTIFICATION_BASE + (req % 1000));
    }

    @Override
    public void load() {
        instance = this;
        ensureIncomingChannel();
        CallForegroundService.ensureChannel(getContext());
        if (pendingLaunchCall != null) {
            notifyListeners("callEvent", pendingLaunchCall);
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) {
            instance = null;
        }
        super.handleOnDestroy();
    }

    @PluginMethod
    public void consumeLaunchCall(PluginCall call) {
        JSObject data = pendingLaunchCall;
        pendingLaunchCall = null;
        if (data == null) {
            call.resolve(new JSObject());
            return;
        }
        call.resolve(data);
    }

    @PluginMethod
    public void ensureChannels(PluginCall call) {
        ensureIncomingChannel();
        CallForegroundService.ensureChannel(getContext());
        ensureBadgeChannel(getContext());
        call.resolve();
    }

    @PluginMethod
    public void requestMediaPermissions(PluginCall call) {
        if (getPermissionState("media") == com.getcapacitor.PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("camera", true);
            ret.put("microphone", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("media", call, "mediaPermsCallback");
    }

    @PermissionCallback
    private void mediaPermsCallback(PluginCall call) {
        boolean cam = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED;
        boolean mic = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED;
        JSObject ret = new JSObject();
        ret.put("camera", cam);
        ret.put("microphone", mic);
        if (cam && mic) {
            call.resolve(ret);
        } else {
            call.reject("Camera/microphone permission denied");
        }
    }

    @PluginMethod
    public void startInCall(PluginCall call) {
        try {
            String title = call.getString("title", "Ямщик");
            String body = call.getString("body", "Идёт звонок");
            Intent intent = new Intent(getContext(), CallForegroundService.class);
            intent.putExtra(CallForegroundService.EXTRA_TITLE, title);
            intent.putExtra(CallForegroundService.EXTRA_BODY, body);
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("startInCall failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void stopInCall(PluginCall call) {
        Intent intent = new Intent(getContext(), CallForegroundService.class);
        getContext().stopService(intent);
        call.resolve();
    }

    @PluginMethod
    public void showIncomingCall(PluginCall call) {
        String callId = call.getString("callId", "");
        String chatId = call.getString("chatId", "");
        String fromUserId = call.getString("fromUserId", "");
        String title = call.getString("title", "Входящий видеозвонок");
        String body = call.getString("body", "Собеседник");
        if (callId.isEmpty() || chatId.isEmpty()) {
            call.reject("callId and chatId required");
            return;
        }
        presentIncomingCallNative(getContext(), callId, chatId, fromUserId, title, body);
        call.resolve();
    }

    @PluginMethod
    public void dismissIncomingCall(PluginCall call) {
        String callId = call.getString("callId", "");
        dismissIncomingCallNative(getContext(), callId);
        call.resolve();
    }

    /**
     * Save an image (base64 payload) into the device gallery via MediaStore.
     * Android WebView cannot use &lt;a download&gt; / reliable Web Share for files.
     */
    @PluginMethod
    public void saveImage(PluginCall call) {
        String base64 = call.getString("base64", "");
        String filename = call.getString("filename", "yamshchik.jpg");
        String mimeType = call.getString("mimeType", "image/jpeg");
        if (base64 == null || base64.isEmpty()) {
            call.reject("base64 required");
            return;
        }
        // Strip data-URL prefix if the web side sent one.
        int comma = base64.indexOf(',');
        if (base64.startsWith("data:") && comma >= 0) {
            base64 = base64.substring(comma + 1);
        }
        if (filename == null || filename.trim().isEmpty()) {
            filename = "yamshchik.jpg";
        }
        if (mimeType == null || mimeType.trim().isEmpty()) {
            mimeType = "image/jpeg";
        }

        // Pre-Q MediaStore writes need WRITE_EXTERNAL_STORAGE.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
                // Same PluginCall is delivered to storagePermsCallback with original options.
                requestPermissionForAlias("storage", call, "storagePermsCallback");
                return;
            }
        }

        try {
            writeImageToGallery(base64, filename, mimeType);
            JSObject ret = new JSObject();
            ret.put("saved", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("saveImage failed: " + e.getMessage(), e);
        }
    }

    @PermissionCallback
    private void storagePermsCallback(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.WRITE_EXTERNAL_STORAGE)
            != PackageManager.PERMISSION_GRANTED) {
            call.reject("Storage permission denied");
            return;
        }
        String base64 = call.getString("base64", "");
        String filename = call.getString("filename", "yamshchik.jpg");
        String mimeType = call.getString("mimeType", "image/jpeg");
        try {
            writeImageToGallery(base64, filename, mimeType);
            JSObject ret = new JSObject();
            ret.put("saved", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("saveImage failed: " + e.getMessage(), e);
        }
    }

    private void writeImageToGallery(String base64, String filename, String mimeType) throws Exception {
        byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
        if (bytes == null || bytes.length == 0) {
            throw new IllegalArgumentException("empty image data");
        }

        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, filename);
        values.put(MediaStore.Images.Media.MIME_TYPE, mimeType);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            values.put(
                MediaStore.Images.Media.RELATIVE_PATH,
                Environment.DIRECTORY_PICTURES + "/Yamshchik"
            );
            values.put(MediaStore.Images.Media.IS_PENDING, 1);
        }

        Uri collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
        Uri uri = resolver.insert(collection, values);
        if (uri == null) {
            throw new IllegalStateException("MediaStore insert failed");
        }

        try (OutputStream out = resolver.openOutputStream(uri)) {
            if (out == null) {
                throw new IllegalStateException("openOutputStream failed");
            }
            out.write(bytes);
            out.flush();
        } catch (Exception e) {
            try {
                resolver.delete(uri, null, null);
            } catch (Exception ignored) {
            }
            throw e;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues done = new ContentValues();
            done.put(MediaStore.Images.Media.IS_PENDING, 0);
            resolver.update(uri, done, null, null);
        }
    }

    /**
     * Sync Android launcher badge with unread total.
     * Web Badging API is unavailable in Capacitor WebView; OEM badges follow
     * active notifications, so unread=0 must cancel message trays (not call UI).
     * When count &gt; 0, replace FCM trays with one silent notification that carries
     * {@link NotificationCompat.Builder#setNumber} so the icon count shrinks as
     * chats are read.
     */
    @PluginMethod
    public void setBadgeCount(PluginCall call) {
        int count = 0;
        Integer raw = call.getInt("count");
        if (raw != null) count = raw;
        applyBadgeCount(getContext(), count);
        call.resolve();
    }

    public static void applyBadgeCount(Context context, int count) {
        if (context == null) return;
        clearMessageNotifications(context);
        if (count <= 0) return;

        ensureBadgeChannel(context);
        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(
            context,
            BADGE_NOTIFICATION_ID,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        int shown = Math.min(Math.max(count, 1), 99);
        String text = shown == 1 ? "1 непрочитанное" : shown + " непрочитанных";
        Notification notification = new NotificationCompat.Builder(context, BADGE_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_coachman)
            .setContentTitle("Ямщик")
            .setContentText(text)
            .setNumber(shown)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setShowWhen(false)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .build();
        try {
            NotificationManagerCompat.from(context).notify(BADGE_NOTIFICATION_ID, notification);
        } catch (SecurityException ignored) {
            // POST_NOTIFICATIONS denied — cancels above still cleared the old badge
        }
    }

    /** Drop FCM / Capacitor message notifications; keep active/incoming call UI. */
    public static void clearMessageNotifications(Context context) {
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            StatusBarNotification[] active = nm.getActiveNotifications();
            if (active != null) {
                for (StatusBarNotification sbn : active) {
                    if (isCallNotificationId(sbn.getId())) continue;
                    nm.cancel(sbn.getTag(), sbn.getId());
                }
                return;
            }
        }
        // Fallback: cancel everything we know is not a call, then badge helper.
        nm.cancel(BADGE_NOTIFICATION_ID);
        // Capacitor / FCM often use small ids; avoid wiping call FGS / ringing.
        for (int id = 0; id < 1000; id++) {
            if (isCallNotificationId(id)) continue;
            nm.cancel(id);
        }
    }

    private static boolean isCallNotificationId(int id) {
        if (id == CallForegroundService.NOTIFICATION_ID) return true;
        if (id == BADGE_NOTIFICATION_ID) return false;
        // IncomingCallRingService: INCOMING_NOTIFICATION_BASE + (hash % 1000)
        return id >= INCOMING_NOTIFICATION_BASE && id < INCOMING_NOTIFICATION_BASE + 1000;
    }

    static void ensureBadgeChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (nm.getNotificationChannel(BADGE_CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
            BADGE_CHANNEL_ID,
            "Счётчик непрочитанных",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Число непрочитанных на иконке приложения");
        channel.enableVibration(false);
        channel.setSound(null, null);
        channel.setShowBadge(true);
        nm.createNotificationChannel(channel);
    }

    @PluginMethod
    public void openFullScreenIntentSettings(PluginCall call) {
        openFullScreenIntentSettings(getContext());
        call.resolve();
    }

    @PluginMethod
    public void canUseFullScreenIntent(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("allowed", canUseFullScreenIntent(getContext()));
        call.resolve(ret);
    }

    private void ensureIncomingChannel() {
        ensureIncomingChannelStatic(getContext());
    }

    static void ensureIncomingChannelStatic(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (nm.getNotificationChannel(INCOMING_CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
            INCOMING_CHANNEL_ID,
            "Входящие звонки",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Полноэкранные входящие видеозвонки");
        channel.enableVibration(true);
        channel.enableLights(true);
        channel.setSound(null, null); // ringtone plays in IncomingCallActivity / ring service
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        channel.setBypassDnd(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            channel.setAllowBubbles(true);
        }
        nm.createNotificationChannel(channel);
    }

    /** Android 14+: full-screen call UI requires an explicit user grant. */
    public static boolean canUseFullScreenIntent(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        return nm != null && nm.canUseFullScreenIntent();
    }

    public static void openFullScreenIntentSettings(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return;
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT);
            intent.setData(Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        } catch (Exception e) {
            try {
                Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                intent.putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(intent);
            } catch (Exception ignored) {
            }
        }
    }
}
