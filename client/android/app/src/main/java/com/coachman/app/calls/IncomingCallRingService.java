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
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.coachman.app.MainActivity;
import com.coachman.app.R;
import com.coachman.app.calls.nativewebrtc.NativeCallActivity;
import com.coachman.app.calls.nativewebrtc.NativeCallLauncher;
import com.coachman.app.calls.permissions.CallPermissionCoordinator;
import com.coachman.app.calls.permissions.CallPermissionState;
import com.coachman.app.calls.permissions.MissedCallDueToPermissionStore;

/**
 * Foreground service while the call is ringing (ringtone + required FGS notif).
 *
 * Full-screen UI is {@link NativeCallActivity}. Notification fullScreenIntent is
 * only reliable when locked/screen-off; unlocked launches must use explicit
 * {@link NativeCallLauncher} (preferably from high-priority FCM).
 *
 * When the app / call UI is already visible, the FGS notification is quiet
 * (no heads-up) so the user does not see a duplicate push.
 */
public class IncomingCallRingService extends Service {
    private static final String TAG = "IncomingCallRing";
    private static final long RING_TIMEOUT_MS = 45_000L;

    public static final String EXTRA_CALL_ID = "callId";
    public static final String EXTRA_CHAT_ID = "chatId";
    public static final String EXTRA_FROM_USER_ID = "fromUserId";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_BODY = "body";
    /** Quiet FGS notif — no heads-up / FSI (app or call UI already visible). */
    public static final String EXTRA_QUIET = "quiet";

    public static final String ACTION_ACCEPT = "com.coachman.app.ACTION_INCOMING_ACCEPT";
    public static final String ACTION_DECLINE = "com.coachman.app.ACTION_INCOMING_DECLINE";
    public static final String ACTION_DISMISS = "com.coachman.app.ACTION_INCOMING_DISMISS";
    public static final String ACTION_DEMOTE = "com.coachman.app.ACTION_INCOMING_DEMOTE";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private PowerManager.WakeLock wakeLock;
    private Ringtone ringtone;
    private Vibrator vibrator;
    private String callId = "";
    private String chatId = "";
    private String fromUserId = "";
    private String title = "";
    private String body = "";
    private boolean quiet;
    private boolean foregroundStarted;

    public static void start(
        Context context,
        String callId,
        String chatId,
        String fromUserId,
        String title,
        String body,
        boolean quiet
    ) {
        Intent intent = new Intent(context, IncomingCallRingService.class);
        intent.putExtra(EXTRA_CALL_ID, callId);
        intent.putExtra(EXTRA_CHAT_ID, chatId);
        intent.putExtra(EXTRA_FROM_USER_ID, fromUserId != null ? fromUserId : "");
        intent.putExtra(EXTRA_TITLE, title != null ? title : "Входящий видеозвонок");
        intent.putExtra(EXTRA_BODY, body != null ? body : "Собеседник");
        intent.putExtra(EXTRA_QUIET, quiet);
        ContextCompat.startForegroundService(context, intent);
    }

    public static void start(
        Context context,
        String callId,
        String chatId,
        String fromUserId,
        String title,
        String body
    ) {
        start(context, callId, chatId, fromUserId, title, body, MainActivity.isInForeground());
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

    /** Call UI is on screen — drop heads-up / FSI so only the activity remains. */
    public static void demoteToQuiet(Context context, String callId) {
        Intent intent = new Intent(context, IncomingCallRingService.class);
        intent.setAction(ACTION_DEMOTE);
        if (callId != null) intent.putExtra(EXTRA_CALL_ID, callId);
        try {
            context.startService(intent);
        } catch (Exception e) {
            Log.w(TAG, "demoteToQuiet failed", e);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }

        if (ACTION_DISMISS.equals(intent.getAction())) {
            String id = safe(intent.getStringExtra(EXTRA_CALL_ID));
            if (id.isEmpty()) id = callId;
            Log.i(TAG, "RING_SERVICE_STOPPED callId=" + id);
            tearDown(id);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (ACTION_DEMOTE.equals(intent.getAction())) {
            String id = safe(intent.getStringExtra(EXTRA_CALL_ID));
            if (!id.isEmpty() && !callId.isEmpty() && !id.equals(callId)) {
                return START_NOT_STICKY;
            }
            quiet = true;
            if (foregroundStarted && !callId.isEmpty()) {
                postNotification(true);
                Log.i(TAG, "RING_NOTIF_DEMOTED callId=" + callId);
            }
            return START_NOT_STICKY;
        }

        callId = safe(intent.getStringExtra(EXTRA_CALL_ID));
        chatId = safe(intent.getStringExtra(EXTRA_CHAT_ID));
        fromUserId = safe(intent.getStringExtra(EXTRA_FROM_USER_ID));
        String titleRaw = safe(intent.getStringExtra(EXTRA_TITLE));
        String bodyRaw = safe(intent.getStringExtra(EXTRA_BODY));
        title = titleRaw.isEmpty() ? "Входящий видеозвонок" : titleRaw;
        body = bodyRaw.isEmpty() ? "Собеседник" : bodyRaw;
        // Once quiet, stay quiet for this ringing session (avoid re-heads-up).
        quiet = quiet || intent.getBooleanExtra(EXTRA_QUIET, false)
            || MainActivity.isInForeground();

        if (callId.isEmpty() || chatId.isEmpty()) {
            postFallbackForeground("Входящий звонок", "Нет данных звонка");
            stopSelf();
            return START_NOT_STICKY;
        }

        Log.i(TAG, "RING_SERVICE_STARTED callId=" + callId + " quiet=" + quiet
            + " foreground=" + MainActivity.isInForeground());

        CoachmanCallsPlugin.ensureIncomingChannelStatic(this);
        CallPermissionState perm = CallPermissionCoordinator.evaluate(this);
        Log.i(TAG, "CALL_PERMISSION_STATE ring"
            + " notificationsEnabled=" + perm.appNotificationsEnabled
            + " notificationsGranted=" + perm.notificationsGranted
            + " channelImportance=" + perm.callChannelImportance
            + " canUseFullScreenIntent=" + perm.fullScreenAllowed
            + " incomingReady=" + perm.incomingCallsReady
        );

        final boolean locked = isDeviceLocked();
        final boolean fsiAllowed = perm.fullScreenAllowed;

        if (!CallPermissionCoordinator.canPresentIncomingNotification(this)) {
            Log.w(TAG, "notifications unavailable — still attempting FGS callId=" + callId);
            MissedCallDueToPermissionStore.mark(this, callId, "notifications");
        }
        if (!quiet && !fsiAllowed) {
            Log.w(TAG, "FSI not granted callId=" + callId);
            MissedCallDueToPermissionStore.mark(this, callId, "fullscreen");
        }

        acquireWakeLock();

        if (!enterForeground(notificationId(callId), buildNotification(quiet, locked))) {
            MissedCallDueToPermissionStore.mark(this, callId, "notifications");
            tearDown(callId);
            stopSelf();
            return START_NOT_STICKY;
        }

        startRinging();

        Log.i(TAG, "launch NativeCallActivity locked=" + locked
            + " quiet=" + quiet + " fsiAllowed=" + fsiAllowed + " callId=" + callId);
        scheduleFullScreenLaunch(locked, fsiAllowed);

        handler.removeCallbacks(timeoutRunnable);
        handler.postDelayed(timeoutRunnable, RING_TIMEOUT_MS);
        return START_NOT_STICKY;
    }

    private final Runnable timeoutRunnable = this::onRingTimedOut;

    @Override
    public void onTimeout(int startId, int fgsType) {
        Log.w(TAG, "shortService onTimeout callId=" + callId);
        onRingTimedOut();
    }

    private void onRingTimedOut() {
        Log.i(TAG, "RING_TIMEOUT callId=" + callId);
        tearDown(callId);
        stopSelf();
    }

    private boolean enterForeground(int notifId, Notification notification) {
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
            foregroundStarted = true;
            return true;
        } catch (Exception e) {
            Log.e(TAG, "startForeground failed callId=" + callId, e);
            try {
                startForeground(notifId, notification);
                foregroundStarted = true;
                return true;
            } catch (Exception e2) {
                Log.e(TAG, "fallback startForeground failed callId=" + callId, e2);
                return false;
            }
        }
    }

    private void postNotification(boolean quietNotif) {
        try {
            Notification n = buildNotification(quietNotif, isDeviceLocked());
            if (foregroundStarted) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    startForeground(
                        notificationId(callId),
                        n,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE
                    );
                } else {
                    startForeground(notificationId(callId), n);
                }
            } else {
                NotificationManagerCompat.from(this).notify(notificationId(callId), n);
            }
        } catch (Exception e) {
            Log.w(TAG, "postNotification failed", e);
        }
    }

    private void postFallbackForeground(String title, String body) {
        try {
            CoachmanCallsPlugin.ensureIncomingChannelStatic(this);
            Notification n = new NotificationCompat.Builder(this, CoachmanCallsPlugin.INCOMING_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_coachman)
                .setContentTitle(title)
                .setContentText(body)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setSilent(true)
                .build();
            enterForeground(notificationId("fallback"), n);
        } catch (Exception ignored) {
        }
    }

    private void scheduleFullScreenLaunch(boolean lockedAtStart, boolean fsiAllowed) {
        final Runnable launch = () -> {
            NativeCallLauncher.launch(
                this, callId, chatId, fromUserId, title, body, lockedAtStart
            );
            if (!quiet && (fsiAllowed || Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE)) {
                sendFullScreenPendingIntent(buildOpenCallPendingIntent(
                    callId, chatId, fromUserId, title, body, lockedAtStart, false, false
                ));
            }
        };
        handler.post(launch);
        handler.postDelayed(launch, 300);
        handler.postDelayed(launch, 800);
        handler.postDelayed(launch, 1600);
    }

    private boolean sendFullScreenPendingIntent(PendingIntent pi) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                ActivityOptions opts = ActivityOptions.makeBasic();
                opts.setPendingIntentBackgroundActivityStartMode(
                    ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED
                );
                pi.send(this, 0, null, null, null, null, opts.toBundle());
            } else {
                pi.send();
            }
            Log.i(TAG, "FULL_SCREEN_PENDING_INTENT_SENT callId=" + callId);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "PendingIntent.send failed callId=" + callId, e);
            return false;
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
        if (ringtone != null) return;
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

    private void tearDown(String id) {
        handler.removeCallbacksAndMessages(null);
        stopRinging();
        releaseWakeLock();
        if (foregroundStarted) {
            try {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } catch (Exception ignored) {
            }
            foregroundStarted = false;
        }
        if (id != null && !id.isEmpty()) {
            CoachmanCallsPlugin.cancelIncomingNotification(this, id);
        }
    }

    private PendingIntent buildOpenCallPendingIntent(
        String callId,
        String chatId,
        String fromUserId,
        String title,
        String body,
        boolean lockedAtStart,
        boolean autoAccept,
        boolean autoReject
    ) {
        int req = Math.abs(callId.hashCode()) & 0xffff;
        if (autoAccept) req = (req + 1) & 0xffff;
        if (autoReject) req = (req + 2) & 0xffff;

        Intent intent = NativeCallActivity.createIntent(
            this, callId, chatId, fromUserId, title, body, lockedAtStart, autoAccept, autoReject
        );
        String suffix = autoAccept ? "/accept" : autoReject ? "/reject" : "/open";
        intent.setData(Uri.parse("coachman://incoming-call/" + callId + suffix));

        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, req, intent, flags);
    }

    private Notification buildNotification(boolean quietNotif, boolean lockedAtStart) {
        PendingIntent openCall = buildOpenCallPendingIntent(
            callId, chatId, fromUserId, title, body, lockedAtStart, false, false
        );
        PendingIntent acceptPi = buildOpenCallPendingIntent(
            callId, chatId, fromUserId, title, body, lockedAtStart, true, false
        );
        PendingIntent declinePi = buildOpenCallPendingIntent(
            callId, chatId, fromUserId, title, body, lockedAtStart, false, true
        );

        if (quietNotif) {
            return new NotificationCompat.Builder(this, CoachmanCallsPlugin.INCOMING_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_coachman)
                .setContentTitle(title)
                .setContentText(body)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setVisibility(NotificationCompat.VISIBILITY_SECRET)
                .setOngoing(true)
                .setSilent(true)
                .setContentIntent(openCall)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .setTimeoutAfter(RING_TIMEOUT_MS)
                .build();
        }

        return new NotificationCompat.Builder(this, CoachmanCallsPlugin.INCOMING_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_coachman)
            .setLargeIcon(android.graphics.BitmapFactory.decodeResource(
                getResources(), R.drawable.ic_app_brand
            ))
            .setContentTitle(title)
            .setContentText(body)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setOnlyAlertOnce(false)
            .setContentIntent(openCall)
            .setFullScreenIntent(openCall, true)
            .addAction(0, "Отклонить", declinePi)
            .addAction(0, "Ответить", acceptPi)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setTimeoutAfter(RING_TIMEOUT_MS)
            .build();
    }

    private void acquireWakeLock() {
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm == null) return;
            if (wakeLock != null && wakeLock.isHeld()) return;
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "coachman:incoming_call");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(RING_TIMEOUT_MS + 5_000L);
        } catch (Exception e) {
            Log.w(TAG, "wakeLock failed", e);
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
        tearDown(callId);
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
