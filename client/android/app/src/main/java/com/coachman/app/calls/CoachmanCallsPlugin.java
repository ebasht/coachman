package com.coachman.app.calls;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.app.Activity;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.annotation.ActivityCallback;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.service.notification.StatusBarNotification;
import android.util.Base64;

import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.coachman.app.MainActivity;
import com.coachman.app.R;
import com.coachman.app.calls.nativewebrtc.NativeCallLauncher;
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
            alias = "bluetooth",
            strings = { Manifest.permission.BLUETOOTH_CONNECT }
        ),
        @Permission(
            alias = "storage",
            strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }
        )
    }
)
public class CoachmanCallsPlugin extends Plugin {
    private static final String TAG = "CoachmanCallsPlugin";
    public static final String INCOMING_CHANNEL_ID =
        com.coachman.app.calls.permissions.CallPermissionCoordinator.CALL_CHANNEL_ID;
    public static final int INCOMING_NOTIFICATION_BASE = 42100;
    /** Silent tray item that drives launcher badge numbers on OEMs that count notifications. */
    public static final String BADGE_CHANNEL_ID = "app_badge";
    public static final int BADGE_NOTIFICATION_ID = 41999;

    private static CoachmanCallsPlugin instance;
    /** After Accept — ignore showIncomingCall until dismissed/ended. */
    private static volatile String suppressIncomingCallId;

    /** Notify live JS listeners after MainActivity persisted the action. */
    public static void notifyCallAction(CallActionStore.PendingAction pending) {
        if (pending == null) return;
        JSObject data = pending.toJsObject();
        CoachmanCallsPlugin plugin = instance;
        if (plugin != null) {
            Log.i(TAG, "event delivered eventId=" + pending.eventId + " callId=" + pending.callId);
            plugin.notifyListeners("callEvent", data);
        } else {
            Log.i(TAG, "event persisted; bridge not ready eventId=" + pending.eventId
                + " callId=" + pending.callId);
        }
    }

    /** @deprecated Prefer CallActionStore via MainActivity; kept for rare legacy callers. */
    @Deprecated
    public static void queueLaunchCall(JSObject data) {
        if (data == null) return;
        String callId = data.getString("callId", "");
        String chatId = data.getString("chatId", "");
        String fromUserId = data.getString("fromUserId", "");
        boolean accept = "true".equals(String.valueOf(data.getString("autoAccept", "")));
        boolean reject = "true".equals(String.valueOf(data.getString("autoReject", "")));
        if (!accept && !reject) return;
        Context ctx = instance != null ? instance.getContext() : null;
        if (ctx == null) return;
        CallActionStore.PendingAction pending = CallActionStore.put(
            ctx,
            accept ? "accept" : "reject",
            callId,
            chatId,
            fromUserId
        );
        notifyCallAction(pending);
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

    public static void emitScreenShareFrame(String jpegBase64, int width, int height) {
        CoachmanCallsPlugin plugin = instance;
        if (plugin == null || jpegBase64 == null) return;
        JSObject data = new JSObject();
        data.put("jpegBase64", jpegBase64);
        data.put("width", width);
        data.put("height", height);
        plugin.notifyListeners("screenShareFrame", data);
    }

    public static void emitScreenShareEnded(String reason) {
        CoachmanCallsPlugin plugin = instance;
        if (plugin == null) return;
        JSObject data = new JSObject();
        data.put("reason", reason != null ? reason : "");
        plugin.notifyListeners("screenShareEnded", data);
    }

    /**
     * Mode A WebView screen share (getDisplayMedia is unavailable in Capacitor WebView).
     * Shows system MediaProjection picker, then streams JPEG frames to JS.
     */
    @PluginMethod
    public void startScreenShare(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("no activity");
            return;
        }
        MediaProjectionManager mpm =
            (MediaProjectionManager) activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (mpm == null) {
            call.reject("MediaProjection unavailable");
            return;
        }
        // Clear FLAG_SECURE so shared frames are not black for this window.
        try {
            activity.getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);
        } catch (Exception ignored) {
        }
        startActivityForResult(call, mpm.createScreenCaptureIntent(), "onScreenSharePermission");
    }

    @ActivityCallback
    private void onScreenSharePermission(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("cancelled");
            return;
        }
        try {
            Intent svc = new Intent(getContext(), ModeAScreenShareService.class);
            svc.setAction(ModeAScreenShareService.ACTION_START);
            svc.putExtra(ModeAScreenShareService.EXTRA_RESULT_CODE, result.getResultCode());
            svc.putExtra(ModeAScreenShareService.EXTRA_RESULT_DATA, result.getData());
            ContextCompat.startForegroundService(getContext(), svc);
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "startScreenShare service failed", e);
            call.reject("start failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void stopScreenShare(PluginCall call) {
        ModeAScreenShareService.stop(getContext());
        call.resolve();
    }

    /**
     * Show native ringing: launch {@link com.coachman.app.calls.nativewebrtc.NativeCallActivity}
     * immediately, then start IncomingCallRingService for ringtone + FGS.
     * When MainActivity is foreground the FGS notification is quiet (no heads-up).
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
        boolean appForeground = MainActivity.isInForeground();
        boolean locked = false;
        try {
            android.app.KeyguardManager km =
                (android.app.KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
            locked = km != null && km.isDeviceLocked();
        } catch (Exception ignored) {
        }
        Log.i(TAG, "FCM_RECEIVED/present incoming-call callId=" + callId
            + " foreground=" + appForeground + " locked=" + locked);

        // Start Activity FIRST — high-priority FCM briefly allows BAL; RingService
        // shortService alone often cannot surface UI when the screen is unlocked.
        NativeCallLauncher.launch(
            context, callId, chatId, fromUserId, title, body, locked
        );

        ensureIncomingChannelStatic(context);
        // Quiet when app already visible — avoids push + call-screen double UI.
        IncomingCallRingService.start(
            context, callId, chatId, fromUserId, title, body, appForeground
        );
    }

    public static void dismissIncomingCallNative(Context context, String callId) {
        IncomingCallActivity.dismissActive(callId);
        IncomingCallRingService.dismissNow(context, callId);
        com.coachman.app.calls.nativewebrtc.NativeCallService.stop(context);
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
        // Do not notifyListeners here — JS listener is not registered yet.
        // React calls peekPendingCallAction() after addListener.
        Log.i(TAG, "bridge plugin loaded");
    }

    @PluginMethod
    public void configureNativeCallAuth(PluginCall call) {
        String baseUrl = call.getString("baseUrl", "");
        String accessToken = call.getString("accessToken", "");
        String userId = call.getString("userId", "");
        if (baseUrl == null || baseUrl.isEmpty() || accessToken == null || accessToken.isEmpty() || userId == null || userId.isEmpty()) {
            call.reject("baseUrl, accessToken, userId required");
            return;
        }
        com.coachman.app.calls.nativewebrtc.NativeCallAuthStore.save(getContext(), baseUrl, accessToken, userId);
        // Register FCM on the native side — JS registration often races auth and never POSTs.
        DeviceTokenRegistrar.syncFromAuthStore(getContext());
        call.resolve();
    }

    @PluginMethod
    public void clearNativeCallAuth(PluginCall call) {
        com.coachman.app.calls.nativewebrtc.NativeCallAuthStore.clear(getContext());
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) {
            instance = null;
        }
        super.handleOnDestroy();
    }

    @PluginMethod
    public void peekPendingCallAction(PluginCall call) {
        CallActionStore.PendingAction pending = CallActionStore.peek(getContext());
        if (pending == null) {
            call.resolve(new JSObject());
            return;
        }
        Log.i(TAG, "peekPendingCallAction eventId=" + pending.eventId + " callId=" + pending.callId);
        call.resolve(pending.toJsObject());
    }

    @PluginMethod
    public void ackPendingCallAction(PluginCall call) {
        String eventId = call.getString("eventId", "");
        boolean ok = CallActionStore.ack(getContext(), eventId);
        JSObject ret = new JSObject();
        ret.put("acked", ok);
        call.resolve(ret);
    }

    /** Compat: peek without ack (legacy name). Prefer peekPendingCallAction + ack. */
    @PluginMethod
    public void consumeLaunchCall(PluginCall call) {
        CallActionStore.PendingAction pending = CallActionStore.peek(getContext());
        if (pending == null) {
            call.resolve(new JSObject());
            return;
        }
        call.resolve(pending.toJsObject());
    }

    @PluginMethod
    public void setCallWindowMode(PluginCall call) {
        Boolean active = call.getBoolean("active", false);
        MainActivity activity = MainActivity.getInstance();
        if (activity != null) {
            activity.setCallWindowMode(Boolean.TRUE.equals(active));
        }
        call.resolve();
    }

    @PluginMethod
    public void getCallLaunchContext(PluginCall call) {
        MainActivity activity = MainActivity.getInstance();
        if (activity != null) {
            call.resolve(activity.getCallLaunchContextJs());
            return;
        }
        CallSessionStore.Session session = CallSessionStore.peek(getContext());
        if (session == null) {
            JSObject empty = new JSObject();
            empty.put("active", false);
            call.resolve(empty);
            return;
        }
        call.resolve(session.toJsObject());
    }

    @PluginMethod
    public void callUiReady(PluginCall call) {
        String callId = call.getString("callId", "");
        IncomingCallActivity.dismissActive(callId);
        MainActivity activity = MainActivity.getInstance();
        if (activity != null) {
            activity.onCallUiReady(callId);
        }
        Log.i(TAG, "CALL_UI_READY callId=" + callId);
        call.resolve();
    }

    @PluginMethod
    public void finishCallAndOpenApp(PluginCall call) {
        String callId = call.getString("callId", "");
        MainActivity activity = MainActivity.getInstance();
        if (activity == null) {
            CallSessionStore.clearIfCall(getContext(), callId);
            JSObject ret = new JSObject();
            ret.put("unlocked", false);
            call.resolve(ret);
            return;
        }
        call.setKeepAlive(true);
        activity.finishCallAndOpenApp(callId, unlocked -> {
            JSObject ret = new JSObject();
            ret.put("unlocked", unlocked);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void closeCallOnlyMode(PluginCall call) {
        String callId = call.getString("callId", "");
        MainActivity activity = MainActivity.getInstance();
        if (activity != null) {
            activity.closeCallOnlyMode(callId);
        } else {
            CallSessionStore.clearIfCall(getContext(), callId);
            IncomingCallRingService.dismissNow(getContext(), callId);
        }
        call.resolve();
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
        Log.i(TAG, "CAMERA_PERMISSION_REQUESTED");
        Log.i(TAG, "MICROPHONE_PERMISSION_REQUESTED");
        boolean cam = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED;
        boolean mic = ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO)
            == PackageManager.PERMISSION_GRANTED;
        if (cam && mic) {
            call.resolve(
                com.coachman.app.calls.permissions.CallPermissionCoordinator.evaluate(getContext()).toJsObject()
            );
            return;
        }
        requestPermissionForAlias("media", call, "mediaPermsCallback");
    }

    @PermissionCallback
    private void mediaPermsCallback(PluginCall call) {
        com.coachman.app.calls.permissions.CallPermissionState state =
            com.coachman.app.calls.permissions.CallPermissionCoordinator.evaluate(getContext());
        Log.i(TAG, "CAMERA_PERMISSION_RESULT granted=" + state.cameraGranted);
        Log.i(TAG, "MICROPHONE_PERMISSION_RESULT granted=" + state.microphoneGranted);
        // Keep legacy keys for older callers.
        JSObject ret = state.toJsObject();
        ret.put("camera", state.cameraGranted);
        ret.put("microphone", state.microphoneGranted);
        call.resolve(ret);
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
            // Mode A (WebView) — without this, remote audio stays on the quiet earpiece.
            boolean speaker = call.getBoolean("speaker", true);
            com.coachman.app.calls.nativewebrtc.NativeCallAudioRouter.enterCall(getContext(), speaker);
            call.resolve();
        } catch (Exception e) {
            call.reject("startInCall failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void stopInCall(PluginCall call) {
        Intent intent = new Intent(getContext(), CallForegroundService.class);
        getContext().stopService(intent);
        com.coachman.app.calls.nativewebrtc.NativeCallAudioRouter.leaveCall();
        call.resolve();
    }

    /** Explicit call audio routing (speaker / earpiece) for Mode A or mid-call toggles. */
    @PluginMethod
    public void setCallAudioRouting(PluginCall call) {
        boolean active = Boolean.TRUE.equals(call.getBoolean("active", false));
        boolean speaker = call.getBoolean("speaker", true);
        if (active) {
            com.coachman.app.calls.nativewebrtc.NativeCallAudioRouter.enterCall(getContext(), speaker);
        } else {
            com.coachman.app.calls.nativewebrtc.NativeCallAudioRouter.leaveCall();
        }
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
    public void openOemCallPermissions(PluginCall call) {
        boolean opened = OemLockScreenHelper.openOemCallPermissions(getContext());
        JSObject ret = new JSObject();
        ret.put("opened", opened);
        ret.put("xiaomi", OemLockScreenHelper.isXiaomiFamily());
        call.resolve(ret);
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

    public static void ensureIncomingChannelStatic(Context context) {
        com.coachman.app.calls.permissions.CallPermissionCoordinator.ensureCallChannel(context);
    }

    /** Android 14+: full-screen call UI requires an explicit user grant. */
    public static boolean canUseFullScreenIntent(Context context) {
        return com.coachman.app.calls.permissions.CallPermissionCoordinator
            .evaluate(context).fullScreenAllowed;
    }

    public static void openFullScreenIntentSettings(Context context) {
        com.coachman.app.calls.permissions.CallPermissionCoordinator.openFullScreenCallSettings(context);
    }

    @PluginMethod
    public void getCallPermissionState(PluginCall call) {
        call.resolve(
            com.coachman.app.calls.permissions.CallPermissionCoordinator.evaluate(getContext()).toJsObject()
        );
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        Log.i(TAG, "NOTIFICATION_PERMISSION_REQUESTED");
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            call.resolve(
                com.coachman.app.calls.permissions.CallPermissionCoordinator.evaluate(getContext()).toJsObject()
            );
            return;
        }
        if (getPermissionState("notifications") == com.getcapacitor.PermissionState.GRANTED) {
            call.resolve(
                com.coachman.app.calls.permissions.CallPermissionCoordinator.evaluate(getContext()).toJsObject()
            );
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermsCallback");
    }

    @PermissionCallback
    private void notificationPermsCallback(PluginCall call) {
        com.coachman.app.calls.permissions.CallPermissionState state =
            com.coachman.app.calls.permissions.CallPermissionCoordinator.evaluate(getContext());
        Log.i(TAG, "NOTIFICATION_PERMISSION_RESULT granted=" + state.notificationsGranted);
        call.resolve(state.toJsObject());
    }

    @PluginMethod
    public void requestBluetoothPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            call.resolve(
                com.coachman.app.calls.permissions.CallPermissionCoordinator.evaluate(getContext()).toJsObject()
            );
            return;
        }
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH_CONNECT)
            == PackageManager.PERMISSION_GRANTED) {
            call.resolve(
                com.coachman.app.calls.permissions.CallPermissionCoordinator.evaluate(getContext()).toJsObject()
            );
            return;
        }
        requestPermissionForAlias("bluetooth", call, "bluetoothPermsCallback");
    }

    @PermissionCallback
    private void bluetoothPermsCallback(PluginCall call) {
        com.coachman.app.calls.permissions.CallPermissionState state =
            com.coachman.app.calls.permissions.CallPermissionCoordinator.evaluate(getContext());
        Log.i(TAG, "BLUETOOTH_PERMISSION_RESULT granted=" + state.bluetoothGranted);
        call.resolve(state.toJsObject());
    }

    @PluginMethod
    public void openFullScreenCallSettings(PluginCall call) {
        com.coachman.app.calls.permissions.CallPermissionCoordinator.openFullScreenCallSettings(getContext());
        call.resolve();
    }

    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        com.coachman.app.calls.permissions.CallPermissionCoordinator.openNotificationSettings(getContext());
        call.resolve();
    }

    @PluginMethod
    public void openCallChannelSettings(PluginCall call) {
        com.coachman.app.calls.permissions.CallPermissionCoordinator.openCallChannelSettings(getContext());
        call.resolve();
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        com.coachman.app.calls.permissions.CallPermissionCoordinator.openAppSettings(getContext());
        call.resolve();
    }

    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        com.coachman.app.calls.permissions.CallPermissionCoordinator.openBatterySettings(getContext());
        call.resolve();
    }

    /** Test incoming call via real ring service + FSI PendingIntent (not direct Activity). */
    @PluginMethod
    public void startTestIncomingCall(PluginCall call) {
        String callId = "test-" + System.currentTimeMillis();
        String chatId = call.getString("chatId", "test-chat");
        presentIncomingCallNative(
            getContext(),
            callId,
            chatId,
            "test-user",
            "Тестовый входящий звонок",
            "Проверка полноэкранного окна"
        );
        call.resolve(new JSObject().put("callId", callId));
    }
}
