package com.coachman.app.calls;

import android.app.ActivityOptions;
import android.app.KeyguardManager;
import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.content.ContextCompat;

import com.coachman.app.MainActivity;
import com.coachman.app.R;

/**
 * Owns ringtone, vibration, wake lock, and the incoming-call foreground notification.
 * Full-screen intent opens {@link MainActivity} in call-only mode (no direct Activity starts).
 */
public class IncomingCallRingService extends Service {
    private static final String TAG = "IncomingCallRing";
    public static final String EXTRA_CALL_ID = "callId";
    public static final String EXTRA_CHAT_ID = "chatId";
    public static final String EXTRA_FROM_USER_ID = "fromUserId";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_BODY = "body";

    public static final String ACTION_ACCEPT = "com.coachman.app.ACTION_INCOMING_ACCEPT";
    public static final String ACTION_DECLINE = "com.coachman.app.ACTION_INCOMING_DECLINE";
    public static final String ACTION_DISMISS = "com.coachman.app.ACTION_INCOMING_DISMISS";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private PowerManager.WakeLock wakeLock;
    private Ringtone ringtone;
    private Vibrator vibrator;
    private String callId = "";

    public static void start(
        Context context,
        String callId,
        String chatId,
        String fromUserId,
        String title,
        String body
    ) {
        Intent intent = new Intent(context, IncomingCallRingService.class);
        intent.putExtra(EXTRA_CALL_ID, callId);
        intent.putExtra(EXTRA_CHAT_ID, chatId);
        intent.putExtra(EXTRA_FROM_USER_ID, fromUserId != null ? fromUserId : "");
        intent.putExtra(EXTRA_TITLE, title != null ? title : "Входящий видеозвонок");
        intent.putExtra(EXTRA_BODY, body != null ? body : "Собеседник");
        ContextCompat.startForegroundService(context, intent);
    }

    public static void stop(Context context) {
        dismissNow(context, null);
    }

    public static void dismissNow(Context context, String callId) {
        Intent intent = new Intent(context, IncomingCallRingService.class);
        intent.setAction(ACTION_DISMISS);
        if (callId != null) intent.putExtra(EXTRA_CALL_ID, callId);
        try {
            context.startService(intent);
        } catch (Exception e) {
            Log.w(TAG, "dismissNow startService failed", e);
            if (callId != null && !callId.isEmpty()) {
                CoachmanCallsPlugin.cancelIncomingNotification(context, callId);
            }
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }

        String action = intent.getAction();
        if (ACTION_DISMISS.equals(action)) {
            String id = safe(intent.getStringExtra(EXTRA_CALL_ID));
            if (id.isEmpty()) id = callId;
            Log.i(TAG, "RING_SERVICE_STOPPED callId=" + id);
            tearDownNotification(id);
            stopSelf();
            return START_NOT_STICKY;
        }

        callId = safe(intent.getStringExtra(EXTRA_CALL_ID));
        final String chatId = safe(intent.getStringExtra(EXTRA_CHAT_ID));
        final String fromUserId = safe(intent.getStringExtra(EXTRA_FROM_USER_ID));
        String titleRaw = safe(intent.getStringExtra(EXTRA_TITLE));
        String bodyRaw = safe(intent.getStringExtra(EXTRA_BODY));
        final String title = titleRaw.isEmpty() ? "Входящий видеозвонок" : titleRaw;
        final String body = bodyRaw.isEmpty() ? "Собеседник" : bodyRaw;

        if (callId.isEmpty() || chatId.isEmpty()) {
            stopSelf();
            return START_NOT_STICKY;
        }

        Log.i(TAG, "RING_SERVICE_STARTED callId=" + callId);

        CoachmanCallsPlugin.ensureIncomingChannelStatic(this);

        final boolean wantFullScreen = needsFullScreenUi();
        final boolean fsiAllowed = CoachmanCallsPlugin.canUseFullScreenIntent(this);
        final boolean useFullScreenIntent = wantFullScreen && fsiAllowed;
        if (wantFullScreen && !fsiAllowed) {
            Log.w(TAG, "USE_FULL_SCREEN_INTENT not granted — CallStyle/heads-up fallback callId="
                + callId);
        }

        acquireWakeLock();

        boolean locked = isDeviceLocked();
        // Always prefer FSI when screen is off or keyguard is up.
        PendingIntent fullScreenPi = buildFullScreenPendingIntent(
            callId, chatId, fromUserId, title, body, locked
        );
        Log.i(TAG, "FULL_SCREEN_INTENT_CREATED callId=" + callId + " fsi=" + useFullScreenIntent
            + " locked=" + locked);

        Notification notification = buildCallNotification(
            callId, chatId, fromUserId, title, body, fullScreenPi, useFullScreenIntent, locked
        );
        int notifId = notificationId(callId);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(
                    notifId,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE
                );
            } else {
                startForeground(notifId, notification);
            }
        } catch (Exception e) {
            Log.e(TAG, "startForeground failed", e);
            try {
                startForeground(notifId, notification);
            } catch (Exception e2) {
                Log.e(TAG, "fallback startForeground failed", e2);
                stopSelf();
                return START_NOT_STICKY;
            }
        }

        startRinging();
        handler.postDelayed(this::stopSelf, 50_000);
        return START_NOT_STICKY;
    }

    private boolean needsFullScreenUi() {
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            boolean interactive = pm == null || pm.isInteractive();
            KeyguardManager km = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
            boolean locked = km != null && km.isKeyguardLocked();
            return !interactive || locked;
        } catch (Exception e) {
            return true;
        }
    }

    private boolean isDeviceLocked() {
        try {
            KeyguardManager km = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
            return km != null && km.isDeviceLocked();
        } catch (Exception e) {
            return false;
        }
    }

    private void startRinging() {
        try {
            Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            ringtone = RingtoneManager.getRingtone(this, uri);
            if (ringtone != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    ringtone.setLooping(true);
                }
                AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
                ringtone.setAudioAttributes(attrs);
                ringtone.play();
            }
        } catch (Exception ignored) {
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                VibratorManager vm = (VibratorManager) getSystemService(VIBRATOR_MANAGER_SERVICE);
                vibrator = vm != null ? vm.getDefaultVibrator() : null;
            } else {
                vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            }
            if (vibrator != null) {
                long[] pattern = new long[] { 0, 800, 400, 800, 400 };
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
                } else {
                    vibrator.vibrate(pattern, 0);
                }
            }
        } catch (Exception ignored) {
        }
    }

    private void stopRinging() {
        try {
            if (ringtone != null && ringtone.isPlaying()) ringtone.stop();
        } catch (Exception ignored) {
        }
        ringtone = null;
        try {
            if (vibrator != null) vibrator.cancel();
        } catch (Exception ignored) {
        }
        vibrator = null;
    }

    private void tearDownNotification(String id) {
        handler.removeCallbacksAndMessages(null);
        stopRinging();
        releaseWakeLock();
        try {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } catch (Exception ignored) {
        }
        if (id != null && !id.isEmpty()) {
            CoachmanCallsPlugin.cancelIncomingNotification(this, id);
        }
    }

    private PendingIntent buildFullScreenPendingIntent(
        String callId,
        String chatId,
        String fromUserId,
        String title,
        String body,
        boolean lockedAtStart
    ) {
        int req = Math.abs(callId.hashCode()) & 0xffff;
        // Dedicated lock-screen Activity — MainActivity (launcher) often fails over keyguard.
        Intent fullIntent = IncomingCallActivity.createIntent(
            this, callId, chatId, fromUserId, title, body, lockedAtStart
        );
        // Unique data so PendingIntents for different calls do not collide.
        fullIntent.setData(android.net.Uri.parse("coachman://incoming-call/" + callId + "/fsi"));

        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            try {
                ActivityOptions opts = ActivityOptions.makeBasic();
                opts.setPendingIntentBackgroundActivityStartMode(
                    ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED
                );
                return PendingIntent.getActivity(this, req, fullIntent, flags, opts.toBundle());
            } catch (Throwable t) {
                Log.w(TAG, "PendingIntent ActivityOptions failed", t);
            }
        }
        return PendingIntent.getActivity(this, req, fullIntent, flags);
    }

    private PendingIntent buildCallPendingIntent(
        String callId,
        String chatId,
        String fromUserId,
        String title,
        String body,
        boolean lockedAtStart,
        boolean accept,
        boolean reject
    ) {
        int req = Math.abs(callId.hashCode()) & 0xffff;
        if (accept) req = (req + 1) & 0xffff;
        if (reject) req = (req + 2) & 0xffff;

        Intent intent = new Intent(this, MainActivity.class);
        intent.setAction(accept ? ACTION_ACCEPT : reject ? ACTION_DECLINE : MainActivity.ACTION_INCOMING_CALL);
        intent.setData(Uri.parse("coachman://incoming-call/" + callId
            + (accept ? "/accept" : reject ? "/reject" : "/ring")));
        intent.setFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                | Intent.FLAG_ACTIVITY_NO_USER_ACTION
        );
        intent.putExtra(MainActivity.EXTRA_MODE, MainActivity.MODE_CALL);
        intent.putExtra(MainActivity.EXTRA_PUSH_TYPE, "incoming-call");
        intent.putExtra(MainActivity.EXTRA_CALL_ID, callId);
        intent.putExtra(MainActivity.EXTRA_CHAT_ID, chatId);
        intent.putExtra(MainActivity.EXTRA_FROM_USER_ID, fromUserId);
        intent.putExtra(MainActivity.EXTRA_TITLE, title);
        intent.putExtra(MainActivity.EXTRA_BODY, body);
        intent.putExtra(MainActivity.EXTRA_LOCKED_AT_START, lockedAtStart);
        intent.putExtra(MainActivity.EXTRA_AUTO_ACCEPT, accept);
        intent.putExtra(MainActivity.EXTRA_AUTO_REJECT, reject);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            try {
                ActivityOptions opts = ActivityOptions.makeBasic();
                opts.setPendingIntentBackgroundActivityStartMode(
                    ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED
                );
                return PendingIntent.getActivity(this, req, intent, flags, opts.toBundle());
            } catch (Throwable t) {
                Log.w(TAG, "PendingIntent ActivityOptions failed", t);
            }
        }
        return PendingIntent.getActivity(this, req, intent, flags);
    }

    private Notification buildCallNotification(
        String callId,
        String chatId,
        String fromUserId,
        String title,
        String body,
        PendingIntent fullScreen,
        boolean useFullScreenIntent,
        boolean lockedAtStart
    ) {
        int req = Math.abs(callId.hashCode()) & 0xffff;
        PendingIntent acceptPi = buildCallPendingIntent(
            callId, chatId, fromUserId, title, body, lockedAtStart, true, false
        );
        PendingIntent declinePi = buildCallPendingIntent(
            callId, chatId, fromUserId, title, body, lockedAtStart, false, true
        );

        Person caller = new Person.Builder()
            .setName(body)
            .setImportant(true)
            .setIcon(androidx.core.graphics.drawable.IconCompat.createWithResource(this, R.drawable.ic_app_brand))
            .build();

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CoachmanCallsPlugin.INCOMING_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_coachman)
            .setLargeIcon(android.graphics.BitmapFactory.decodeResource(getResources(), R.drawable.ic_app_brand))
            .setContentTitle(title)
            .setContentText(body)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setOnlyAlertOnce(false)
            .setContentIntent(fullScreen)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, declinePi, acceptPi))
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setTimeoutAfter(45_000);

        if (useFullScreenIntent) {
            builder.setFullScreenIntent(fullScreen, true);
            // Content tap also opens lock-screen call UI.
            builder.setContentIntent(fullScreen);
        } else {
            builder.setContentIntent(
                buildCallPendingIntent(callId, chatId, fromUserId, title, body, lockedAtStart, false, false)
            );
        }
        return builder.build();
    }

    private void acquireWakeLock() {
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm == null) return;
            @SuppressWarnings("deprecation")
            int flags = PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                | PowerManager.ACQUIRE_CAUSES_WAKEUP
                | PowerManager.ON_AFTER_RELEASE;
            wakeLock = pm.newWakeLock(flags, "coachman:incoming_call");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(60_000);
        } catch (Exception e) {
            Log.w(TAG, "wakeLock failed, trying partial", e);
            try {
                PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                if (pm == null) return;
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "coachman:incoming_call");
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire(60_000);
            } catch (Exception e2) {
                Log.w(TAG, "partial wakeLock failed", e2);
            }
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) {
        }
        wakeLock = null;
    }

    static int notificationId(String callId) {
        int req = Math.abs(callId.hashCode()) & 0xffff;
        return CoachmanCallsPlugin.INCOMING_NOTIFICATION_BASE + (req % 1000);
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        stopRinging();
        releaseWakeLock();
        try {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } catch (Exception ignored) {
        }
        if (!callId.isEmpty()) {
            CoachmanCallsPlugin.cancelIncomingNotification(this, callId);
        }
        Log.i(TAG, "ring service onDestroy callId=" + callId);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private static String safe(String v) {
        return v == null ? "" : v;
    }
}
