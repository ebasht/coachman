package com.coachman.app.calls.nativewebrtc;

import android.content.Context;

import org.webrtc.Camera2Enumerator;
import org.webrtc.CameraVideoCapturer;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;

/** Camera capture only after Answer. */
public final class NativeCameraController {
    private CameraVideoCapturer capturer;
    private VideoSource source;
    private VideoTrack track;
    private boolean started;

    public VideoTrack start(
        Context context,
        org.webrtc.PeerConnectionFactory factory,
        org.webrtc.EglBase.Context egl,
        boolean front
    ) {
        if (started && track != null) return track;
        Camera2Enumerator enumerator = new Camera2Enumerator(context);
        String deviceName = null;
        for (String name : enumerator.getDeviceNames()) {
            if (front == enumerator.isFrontFacing(name)) {
                deviceName = name;
                break;
            }
        }
        if (deviceName == null) {
            String[] names = enumerator.getDeviceNames();
            if (names.length == 0) throw new IllegalStateException("no camera");
            deviceName = names[0];
        }
        capturer = enumerator.createCapturer(deviceName, null);
        source = factory.createVideoSource(false);
        SurfaceTextureHelper helper = SurfaceTextureHelper.create("NativeCallCapture", egl);
        capturer.initialize(helper, context, source.getCapturerObserver());
        capturer.startCapture(1280, 720, 30);
        track = factory.createVideoTrack("native_video", source);
        track.setEnabled(true);
        started = true;
        NativeCallLogger.i("NATIVE_LOCAL_CAPTURE_STARTED", "");
        return track;
    }

    public void switchCamera() {
        if (capturer != null) {
            capturer.switchCamera(null);
        }
    }

    public void setEnabled(boolean enabled) {
        if (track != null) track.setEnabled(enabled);
    }

    public boolean isStarted() {
        return started;
    }

    public VideoTrack getTrack() {
        return track;
    }

    public void stop() {
        try {
            if (capturer != null) {
                capturer.stopCapture();
                capturer.dispose();
            }
        } catch (Exception ignored) {
        }
        capturer = null;
        if (source != null) source.dispose();
        source = null;
        if (track != null) track.dispose();
        track = null;
        started = false;
    }
}
