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
        source = factory.createAudioSource(new MediaConstraints());
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
        if (track != null) track.dispose();
        track = null;
        if (source != null) source.dispose();
        source = null;
        started = false;
    }
}
