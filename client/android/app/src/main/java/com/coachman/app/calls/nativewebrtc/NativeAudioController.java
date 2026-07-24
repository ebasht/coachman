package com.coachman.app.calls.nativewebrtc;

import org.webrtc.AudioSource;
import org.webrtc.AudioTrack;
import org.webrtc.MediaConstraints;
import org.webrtc.PeerConnectionFactory;

/** Microphone track only after Answer. */
public final class NativeAudioController {
    private AudioSource source;
    private AudioTrack track;
    private boolean started;

    public AudioTrack start(PeerConnectionFactory factory) {
        if (started && track != null) return track;
        MediaConstraints constraints = new MediaConstraints();
        // Soften mic for WebRTC APM — empty constraints often under-level on Android OEMs.
        constraints.optional.add(new MediaConstraints.KeyValuePair("googEchoCancellation", "true"));
        constraints.optional.add(new MediaConstraints.KeyValuePair("googAutoGainControl", "true"));
        constraints.optional.add(new MediaConstraints.KeyValuePair("googNoiseSuppression", "true"));
        constraints.optional.add(new MediaConstraints.KeyValuePair("googHighpassFilter", "true"));
        source = factory.createAudioSource(constraints);
        track = factory.createAudioTrack("native_audio", source);
        track.setEnabled(true);
        started = true;
        return track;
    }

    public void setMuted(boolean muted) {
        if (track != null) track.setEnabled(!muted);
    }

    public boolean isStarted() {
        return started;
    }

    public AudioTrack getTrack() {
        return track;
    }

    public void stop() {
        if (track != null) {
            try {
                track.setEnabled(false);
            } catch (Exception ignored) {
            }
            try {
                track.dispose();
            } catch (Exception ignored) {
            }
        }
        track = null;
        if (source != null) {
            try {
                source.dispose();
            } catch (Exception ignored) {
            }
        }
        source = null;
        started = false;
    }
}
