package com.coachman.app.calls;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

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
        )
    }
)
public class CoachmanCallsPlugin extends Plugin {
    public static final String INCOMING_CHANNEL_ID = "incoming_calls";
    public static final int INCOMING_NOTIFICATION_BASE = 42100;

    private static JSObject pendingLaunchCall;
    private static CoachmanCallsPlugin instance;

    public static void queueLaunchCall(JSObject data) {
        pendingLaunchCall = data;
        if (instance != null) {
            instance.notifyListeners("callEvent", data);
        }
    }

    public static void presentIncomingCallNative(
        Context context,
        String callId,
        String chatId,
        String fromUserId,
        String title,
        String body
    ) {
        ensureIncomingChannelStatic(context);
        IncomingCallActivity.start(context, callId, chatId, fromUserId, title, body);
        postIncomingNotification(context, callId, chatId, fromUserId, title, body);
    }

    public static void dismissIncomingCallNative(Context context, String callId) {
        IncomingCallActivity.dismiss(context, callId);
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

    @PluginMethod
    public void openFullScreenIntentSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        }
        call.resolve();
    }

    private static void postIncomingNotification(
        Context context,
        String callId,
        String chatId,
        String fromUserId,
        String title,
        String body
    ) {
        Intent open = new Intent(context, IncomingCallActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        open.putExtra(IncomingCallActivity.EXTRA_CALL_ID, callId);
        open.putExtra(IncomingCallActivity.EXTRA_CHAT_ID, chatId);
        open.putExtra(IncomingCallActivity.EXTRA_FROM_USER_ID, fromUserId);
        open.putExtra(IncomingCallActivity.EXTRA_TITLE, title);
        open.putExtra(IncomingCallActivity.EXTRA_BODY, body);

        int req = Math.abs(callId.hashCode()) & 0xffff;
        PendingIntent fullScreen = PendingIntent.getActivity(
            context,
            req,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, INCOMING_CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(true)
            .setContentIntent(fullScreen)
            .setFullScreenIntent(fullScreen, true)
            .setTimeoutAfter(45_000);

        try {
            NotificationManagerCompat.from(context).notify(INCOMING_NOTIFICATION_BASE + (req % 1000), builder.build());
        } catch (SecurityException ignored) {
        }
    }

    private void ensureIncomingChannel() {
        ensureIncomingChannelStatic(getContext());
    }

    static void ensureIncomingChannelStatic(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel channel = new NotificationChannel(
            INCOMING_CHANNEL_ID,
            "Входящие звонки",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Входящие видеозвонки Ямщика");
        channel.enableVibration(true);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        channel.setBypassDnd(true);
        nm.createNotificationChannel(channel);
    }
}
