package com.coachman.app.calls.nativewebrtc;

import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjection;
import android.os.Handler;
import android.os.Looper;

import org.webrtc.PeerConnectionFactory;
import org.webrtc.ScreenCapturerAndroid;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;

/** Screen capture via MediaProjection + WebRTC ScreenCapturerAndroid. */
public final class NativeScreenCapturer {
    public interface StopListener {
        void onStopped();
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private ScreenCapturerAndroid capturer;
    private SurfaceTextureHelper helper;
    private VideoSource source;
    private VideoTrack track;
    private StopListener stopListener;
    private boolean started;
    private boolean stopping;

    public VideoTrack start(
        Context context,
        PeerConnectionFactory factory,
        org.webrtc.EglBase.Context egl,
        Intent projectionData,
        StopListener stopListener
    ) {
        if (started && track != null) return track;
        this.stopListener = stopListener;
        MediaProjection.Callback callback = new MediaProjection.Callback() {
            @Override
            public void onStop() {
                main.post(() -> {
                    if (stopping || !started) return;
                    NativeCallLogger.i("NATIVE_SCREEN_PROJECTION_STOPPED", "");
                    StopListener listener = NativeScreenCapturer.this.stopListener;
                    NativeScreenCapturer.this.stopListener = null;
                    if (listener != null) {
                        // Client replaces outbound track then calls stop().
                        listener.onStopped();
                    } else {
                        stopInternal();
                    }
                });
            }
        };
        capturer = new ScreenCapturerAndroid(projectionData, callback);
        source = factory.createVideoSource(true);
        helper = SurfaceTextureHelper.create("NativeScreenCapture", egl);
        capturer.initialize(helper, context.getApplicationContext(), source.getCapturerObserver());
        capturer.startCapture(1280, 720, 15);
        track = factory.createVideoTrack("native_screen", source);
        track.setEnabled(true);
        started = true;
        NativeCallLogger.i("NATIVE_SCREEN_CAPTURE_STARTED", "");
        return track;
    }

    public VideoTrack getTrack() {
        return track;
    }

    public boolean isStarted() {
        return started;
    }

    /** Intentional stop — does not invoke {@link StopListener}. */
    public void stop() {
        stopping = true;
        stopListener = null;
        stopInternal();
        stopping = false;
    }

    private void stopInternal() {
        try {
            if (capturer != null) {
                capturer.stopCapture();
                capturer.dispose();
            }
        } catch (Exception ignored) {
        }
        capturer = null;
        if (helper != null) {
            try {
                helper.dispose();
            } catch (Exception ignored) {
            }
        }
        helper = null;
        if (source != null) {
            try {
                source.dispose();
            } catch (Exception ignored) {
            }
        }
        source = null;
        if (track != null) {
            try {
                track.dispose();
            } catch (Exception ignored) {
            }
        }
        track = null;
        started = false;
    }
}
