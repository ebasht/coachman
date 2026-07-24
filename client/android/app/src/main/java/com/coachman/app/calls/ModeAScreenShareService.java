package com.coachman.app.calls;

import android.app.Activity;
import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;

import androidx.core.app.NotificationCompat;

import com.coachman.app.MainActivity;
import com.coachman.app.R;
import com.getcapacitor.JSObject;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/**
 * Mode A (WebView) screen share: MediaProjection → JPEG frames → Capacitor events.
 * Mode B uses native WebRTC ScreenCapturerAndroid instead.
 */
public class ModeAScreenShareService extends Service {
    private static final String TAG = "ModeAScreenShare";
    public static final String ACTION_START = "com.coachman.app.MODE_A_SCREEN_START";
    public static final String ACTION_STOP = "com.coachman.app.MODE_A_SCREEN_STOP";
    public static final String EXTRA_RESULT_CODE = "resultCode";
    public static final String EXTRA_RESULT_DATA = "resultData";
    private static final int NOTIF_ID = 42002;
    private static final int WIDTH = 960;
    private static final int HEIGHT = 540;
    private static final long MIN_FRAME_INTERVAL_MS = 100; // ~10 fps

    private MediaProjection projection;
    private VirtualDisplay virtualDisplay;
    private ImageReader imageReader;
    private HandlerThread captureThread;
    private Handler captureHandler;
    private long lastFrameAt;
    private boolean running;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        String action = intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopCapture();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!ACTION_START.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }

        int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED);
        Intent data;
        if (Build.VERSION.SDK_INT >= 33) {
            data = intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent.class);
        } else {
            data = intent.getParcelableExtra(EXTRA_RESULT_DATA);
        }
        if (resultCode != Activity.RESULT_OK || data == null) {
            Log.e(TAG, "missing projection permission data");
            CoachmanCallsPlugin.emitScreenShareEnded("permission");
            stopSelf();
            return START_NOT_STICKY;
        }

        try {
            if (!startAsForeground()) {
                CoachmanCallsPlugin.emitScreenShareEnded("foreground");
                stopSelf();
                return START_NOT_STICKY;
            }
            startCapture(resultCode, data);
            running = true;
            Log.i(TAG, "screen share capture started");
        } catch (Exception e) {
            Log.e(TAG, "startCapture failed", e);
            CoachmanCallsPlugin.emitScreenShareEnded("start:" + e.getMessage());
            stopCapture();
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    private boolean startAsForeground() {
        try {
            CoachmanCallsPlugin.ensureIncomingChannelStatic(this);
            Intent open = new Intent(this, MainActivity.class);
            open.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent pi = PendingIntent.getActivity(
                this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            Notification n = new NotificationCompat.Builder(this, CoachmanCallsPlugin.INCOMING_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_coachman)
                .setContentTitle("Демонстрация экрана")
                .setContentText("Идёт видеозвонок")
                .setContentIntent(pi)
                .setOngoing(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            } else if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            } else {
                startForeground(NOTIF_ID, n);
            }
            return true;
        } catch (Exception e) {
            Log.e(TAG, "startForeground failed", e);
            return false;
        }
    }

    private void startCapture(int resultCode, Intent data) {
        MediaProjectionManager mpm =
            (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        if (mpm == null) throw new IllegalStateException("no MediaProjectionManager");

        captureThread = new HandlerThread("ModeAScreenCapture");
        captureThread.start();
        captureHandler = new Handler(captureThread.getLooper());

        projection = mpm.getMediaProjection(resultCode, data);
        if (projection == null) throw new IllegalStateException("getMediaProjection null");
        projection.registerCallback(new MediaProjection.Callback() {
            @Override
            public void onStop() {
                Log.i(TAG, "MediaProjection stopped");
                captureHandler.post(() -> {
                    CoachmanCallsPlugin.emitScreenShareEnded("stopped");
                    stopCapture();
                    stopSelf();
                });
            }
        }, captureHandler);

        imageReader = ImageReader.newInstance(WIDTH, HEIGHT, PixelFormat.RGBA_8888, 2);
        imageReader.setOnImageAvailableListener(this::onImage, captureHandler);

        int dpi = 320;
        try {
            WindowManager wm = (WindowManager) getSystemService(WINDOW_SERVICE);
            if (wm != null) {
                DisplayMetrics metrics = new DisplayMetrics();
                wm.getDefaultDisplay().getRealMetrics(metrics);
                dpi = metrics.densityDpi;
            }
        } catch (Exception ignored) {
        }

        virtualDisplay = projection.createVirtualDisplay(
            "CoachmanModeAShare",
            WIDTH,
            HEIGHT,
            dpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader.getSurface(),
            null,
            captureHandler
        );
    }

    private void onImage(ImageReader reader) {
        Image image = null;
        try {
            image = reader.acquireLatestImage();
            if (image == null || !running) return;
            long now = System.currentTimeMillis();
            if (now - lastFrameAt < MIN_FRAME_INTERVAL_MS) return;
            lastFrameAt = now;

            Image.Plane plane = image.getPlanes()[0];
            ByteBuffer buffer = plane.getBuffer();
            int pixelStride = plane.getPixelStride();
            int rowStride = plane.getRowStride();
            int rowPadding = rowStride - pixelStride * WIDTH;

            Bitmap bitmap = Bitmap.createBitmap(
                WIDTH + rowPadding / pixelStride,
                HEIGHT,
                Bitmap.Config.ARGB_8888
            );
            bitmap.copyPixelsFromBuffer(buffer);
            Bitmap cropped = Bitmap.createBitmap(bitmap, 0, 0, WIDTH, HEIGHT);
            if (cropped != bitmap) bitmap.recycle();

            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            cropped.compress(Bitmap.CompressFormat.JPEG, 55, bos);
            cropped.recycle();
            String b64 = Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
            CoachmanCallsPlugin.emitScreenShareFrame(b64, WIDTH, HEIGHT);
        } catch (Exception e) {
            Log.w(TAG, "frame encode failed", e);
        } finally {
            if (image != null) image.close();
        }
    }

    private void stopCapture() {
        running = false;
        try {
            if (virtualDisplay != null) virtualDisplay.release();
        } catch (Exception ignored) {
        }
        virtualDisplay = null;
        try {
            if (imageReader != null) imageReader.close();
        } catch (Exception ignored) {
        }
        imageReader = null;
        try {
            if (projection != null) projection.stop();
        } catch (Exception ignored) {
        }
        projection = null;
        if (captureThread != null) {
            captureThread.quitSafely();
            captureThread = null;
        }
        captureHandler = null;
        try {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onDestroy() {
        stopCapture();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    public static void stop(Context context) {
        Intent i = new Intent(context, ModeAScreenShareService.class);
        i.setAction(ACTION_STOP);
        try {
            context.startService(i);
        } catch (Exception e) {
            context.stopService(new Intent(context, ModeAScreenShareService.class));
        }
    }
}
