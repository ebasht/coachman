package com.coachman.app.calls.nativewebrtc;

import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;
import org.webrtc.AudioTrack;
import org.webrtc.DataChannel;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.MediaStreamTrack;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpReceiver;
import org.webrtc.RtpSender;
import org.webrtc.RtpTransceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.VideoTrack;
import org.webrtc.audio.JavaAudioDeviceModule;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/** One PeerConnection for preview → active. */
public final class NativePeerConnectionClient {
    public interface Callbacks {
        void onRemoteVideoTrack(VideoTrack track);
        void onIceCandidate(IceCandidate candidate, String stage);
        void onLocalSdp(SessionDescription sdp, String stage);
        void onConnectionChange(PeerConnection.PeerConnectionState state);
        void onError(String message);
        /** Outbound video changed (camera ↔ screen). */
        default void onLocalVideoTrack(VideoTrack track) {}
    }

    private static final AtomicBoolean factoryInit = new AtomicBoolean(false);

    private final Context app;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final NativeCameraController camera = new NativeCameraController();
    private final NativeAudioController audio = new NativeAudioController();
    private final NativeScreenCapturer screen = new NativeScreenCapturer();
    private final AtomicBoolean pcCreated = new AtomicBoolean(false);
    private final AtomicBoolean sdpBusy = new AtomicBoolean(false);

    private EglBase eglBase;
    private PeerConnectionFactory factory;
    private PeerConnection pc;
    private Callbacks callbacks;
    private String stage = "preview";
    private final List<IceCandidate> pendingRemoteIce = new ArrayList<>();
    private RtpSender videoSender;
    private boolean frontCamera = true;
    private boolean screenSharing;
    private boolean cameraEnabled = true;

    public NativePeerConnectionClient(Context context) {
        this.app = context.getApplicationContext();
    }

    public EglBase getEglBase() {
        return eglBase;
    }

    public boolean hasPeerConnection() {
        return pc != null;
    }

    public NativeCameraController camera() {
        return camera;
    }

    public NativeAudioController audio() {
        return audio;
    }

    public void prepareFactory(Callbacks callbacks) {
        this.callbacks = callbacks;
        if (factoryInit.compareAndSet(false, true)) {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(app)
                    .createInitializationOptions()
            );
        }
        if (eglBase == null) {
            eglBase = EglBase.create();
        }
        if (factory == null) {
            JavaAudioDeviceModule adm = JavaAudioDeviceModule.builder(app)
                .setUseHardwareAcousticEchoCanceler(true)
                .setUseHardwareNoiseSuppressor(true)
                .createAudioDeviceModule();
            factory = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(new DefaultVideoEncoderFactory(eglBase.getEglBaseContext(), true, true))
                .setVideoDecoderFactory(new DefaultVideoDecoderFactory(eglBase.getEglBaseContext()))
                .setAudioDeviceModule(adm)
                .createPeerConnectionFactory();
        }
    }

    /** Create empty preview PC — answerer must not pre-add m-lines (Unified Plan). */
    public void ensurePreviewPeerConnection(String baseUrl, String bearerToken) {
        if (pcCreated.get() && pc != null) {
            NativeCallLogger.i("NATIVE_PC_REUSE", "");
            return;
        }
        io.execute(() -> {
            try {
                List<PeerConnection.IceServer> ice = fetchIce(baseUrl, bearerToken);
                main.post(() -> createPreviewPc(ice));
            } catch (Exception e) {
                NativeCallLogger.e("NATIVE_ICE_FETCH_FAIL", "", e);
                main.post(() -> createPreviewPc(defaultStun()));
            }
        });
    }

    private void createPreviewPc(List<PeerConnection.IceServer> ice) {
        if (pcCreated.get() && pc != null) return;
        PeerConnection.RTCConfiguration cfg = new PeerConnection.RTCConfiguration(ice);
        cfg.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
        pc = factory.createPeerConnection(cfg, new PeerConnection.Observer() {
            @Override public void onSignalingChange(PeerConnection.SignalingState signalingState) {
                NativeCallLogger.i("NATIVE_SIGNALING_STATE", "", String.valueOf(signalingState));
            }
            @Override public void onIceConnectionChange(PeerConnection.IceConnectionState iceConnectionState) {}
            @Override public void onIceConnectionReceivingChange(boolean b) {}
            @Override public void onIceGatheringChange(PeerConnection.IceGatheringState iceGatheringState) {}
            @Override
            public void onIceCandidate(IceCandidate iceCandidate) {
                main.post(() -> {
                    if (callbacks != null) callbacks.onIceCandidate(iceCandidate, stage);
                });
            }
            @Override public void onIceCandidatesRemoved(IceCandidate[] iceCandidates) {}
            @Override public void onAddStream(MediaStream mediaStream) {}
            @Override public void onRemoveStream(MediaStream mediaStream) {}
            @Override public void onDataChannel(DataChannel dataChannel) {}
            @Override public void onRenegotiationNeeded() {}
            @Override
            public void onAddTrack(RtpReceiver rtpReceiver, MediaStream[] mediaStreams) {
                if (rtpReceiver != null && rtpReceiver.track() instanceof VideoTrack) {
                    VideoTrack vt = (VideoTrack) rtpReceiver.track();
                    NativeCallLogger.i("NATIVE_REMOTE_TRACK_RECEIVED", "");
                    // Observers run on signaling thread — UI/EGL only on main.
                    main.post(() -> {
                        if (callbacks != null) callbacks.onRemoteVideoTrack(vt);
                    });
                }
            }
            @Override
            public void onConnectionChange(PeerConnection.PeerConnectionState newState) {
                main.post(() -> {
                    if (callbacks != null) callbacks.onConnectionChange(newState);
                });
            }
        });
        if (pc == null) {
            if (callbacks != null) callbacks.onError("PeerConnection create failed");
            return;
        }
        // No addTransceiver here. iPhone preview offer is video-only; libwebrtc creates
        // matching recvonly transceiver(s) in setRemoteDescription. Pre-adding audio
        // INACTIVE caused SIGABRT in createAnswer (never reached PREVIEW_ANSWER_SENT).
        pcCreated.set(true);
        stage = "preview";
        NativeCallLogger.i("NATIVE_PREVIEW_PC_READY", "", "transceivers=0");
    }

    public void setRemoteOffer(String sdp, String offerStage) {
        if (pc == null || sdp == null) return;
        if (sdpBusy.get()) {
            NativeCallLogger.i("NATIVE_SET_REMOTE_OFFER_BUSY", "");
            return;
        }
        if (pc.signalingState() != PeerConnection.SignalingState.STABLE) {
            NativeCallLogger.w("NATIVE_SET_REMOTE_OFFER_BAD_STATE", "",
                new IllegalStateException(String.valueOf(pc.signalingState())));
            return;
        }
        if ("active".equals(stage) && pc.getLocalDescription() != null
            && pc.getLocalDescription().type == SessionDescription.Type.OFFER) {
            NativeCallLogger.i("NATIVE_PREVIEW_OFFER_SKIP_ACTIVE", "");
            return;
        }
        sdpBusy.set(true);
        stage = offerStage == null ? "preview" : offerStage;
        NativeCallLogger.i("NATIVE_SDP_SET_REMOTE_START", "",
            "stage=" + stage + " " + sdpSummary(sdp));
        SessionDescription offer = new SessionDescription(SessionDescription.Type.OFFER, sdp);
        pc.setRemoteDescription(new SdpAdapter() {
            @Override
            public void onSetSuccess() {
                NativeCallLogger.i("NATIVE_SDP_SET_REMOTE_OK", "",
                    "state=" + pc.signalingState() + " trx=" + pc.getTransceivers().size());
                flushRemoteIce();
                NativeCallLogger.i("NATIVE_SDP_CREATE_ANSWER_START", "");
                MediaConstraints c = new MediaConstraints();
                pc.createAnswer(new SdpAdapter() {
                    @Override
                    public void onCreateSuccess(SessionDescription sessionDescription) {
                        NativeCallLogger.i("NATIVE_SDP_CREATE_ANSWER_OK", "",
                            sdpSummary(sessionDescription.description));
                        NativeCallLogger.i("NATIVE_SDP_SET_LOCAL_START", "", "stage=" + stage);
                        pc.setLocalDescription(new SdpAdapter() {
                            @Override
                            public void onSetSuccess() {
                                sdpBusy.set(false);
                                NativeCallLogger.i("NATIVE_SDP_SET_LOCAL_OK", "",
                                    "state=" + pc.signalingState());
                                SessionDescription answer = sessionDescription;
                                String answerStage = stage;
                                main.post(() -> {
                                    if (callbacks != null) {
                                        callbacks.onLocalSdp(answer, answerStage);
                                    }
                                });
                            }

                            @Override
                            public void onSetFailure(String error) {
                                sdpBusy.set(false);
                                NativeCallLogger.w("NATIVE_PREVIEW_ANSWER_SET_FAIL", "", new Exception(error));
                            }
                        }, sessionDescription);
                    }

                    @Override
                    public void onCreateFailure(String error) {
                        sdpBusy.set(false);
                        NativeCallLogger.w("NATIVE_PREVIEW_ANSWER_CREATE_FAIL", "", new Exception(error));
                    }
                }, c);
            }

            @Override
            public void onSetFailure(String error) {
                sdpBusy.set(false);
                NativeCallLogger.w("NATIVE_PREVIEW_REMOTE_SET_FAIL", "", new Exception(error));
            }
        }, offer);
    }

    public void setRemoteAnswer(String sdp) {
        if (pc == null || sdp == null) return;
        sdpBusy.set(true);
        NativeCallLogger.i("NATIVE_SDP_SET_REMOTE_ANSWER_START", "", sdpSummary(sdp));
        pc.setRemoteDescription(new SdpAdapter() {
            @Override
            public void onSetSuccess() {
                sdpBusy.set(false);
                flushRemoteIce();
                NativeCallLogger.i("NATIVE_ACTIVE_ANSWER_APPLIED", "");
            }

            @Override
            public void onSetFailure(String error) {
                sdpBusy.set(false);
                NativeCallLogger.w("NATIVE_ACTIVE_ANSWER_SET_FAIL", "", new Exception(error));
            }
        }, new SessionDescription(SessionDescription.Type.ANSWER, sdp));
    }

    public void addRemoteIce(IceCandidate candidate) {
        if (candidate == null) return;
        if (pc == null || pc.getRemoteDescription() == null) {
            pendingRemoteIce.add(candidate);
            return;
        }
        pc.addIceCandidate(candidate);
    }

    public boolean isSignalingStable() {
        return pc != null && pc.signalingState() == PeerConnection.SignalingState.STABLE;
    }

    public boolean isSdpBusy() {
        return sdpBusy.get();
    }

    /** After Answer: start local A/V once, renegotiate sendrecv, create active offer. */
    public void startLocalMediaAndCreateActiveOffer(boolean frontCamera) {
        if (pc == null || factory == null || eglBase == null) {
            if (callbacks != null) callbacks.onError("PC not ready");
            return;
        }
        if (sdpBusy.get() || pc.signalingState() != PeerConnection.SignalingState.STABLE) {
            NativeCallLogger.i("NATIVE_ACTIVE_OFFER_DEFER", "", "state=" + pc.signalingState());
            main.postDelayed(() -> startLocalMediaAndCreateActiveOffer(frontCamera), 100);
            return;
        }
        if (camera.isStarted()) {
            NativeCallLogger.i("NATIVE_CAPTURE_ALREADY", "");
        } else {
            try {
                this.frontCamera = frontCamera;
                VideoTrack vt = camera.start(app, factory, eglBase.getEglBaseContext(), frontCamera);
                AudioTrack at = audio.start(factory);
                boolean videoBound = false;
                boolean audioBound = false;
                for (RtpTransceiver t : pc.getTransceivers()) {
                    if (t.getMediaType() == MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO && !videoBound) {
                        t.setDirection(RtpTransceiver.RtpTransceiverDirection.SEND_RECV);
                        videoSender = t.getSender();
                        videoSender.setTrack(vt, false);
                        videoBound = true;
                    } else if (t.getMediaType() == MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO && !audioBound) {
                        t.setDirection(RtpTransceiver.RtpTransceiverDirection.SEND_RECV);
                        t.getSender().setTrack(at, false);
                        audioBound = true;
                    }
                }
                if (!videoBound) {
                    videoSender = pc.addTrack(vt);
                }
                if (!audioBound) {
                    pc.addTrack(at);
                }
                NativeCallLogger.i("NATIVE_LOCAL_CAPTURE_STARTED", "",
                    "videoBound=" + videoBound + " audioBound=" + audioBound
                        + " trx=" + pc.getTransceivers().size());
            } catch (Exception e) {
                NativeCallLogger.e("NATIVE_LOCAL_MEDIA_FAIL", "", e);
                if (callbacks != null) callbacks.onError("Camera/mic failed");
                return;
            }
        }
        sdpBusy.set(true);
        stage = "active";
        NativeCallLogger.i("NATIVE_SDP_CREATE_ACTIVE_OFFER_START", "");
        pc.createOffer(new SdpAdapter() {
            @Override
            public void onCreateSuccess(SessionDescription sessionDescription) {
                NativeCallLogger.i("NATIVE_SDP_CREATE_ACTIVE_OFFER_OK", "",
                    sdpSummary(sessionDescription.description));
                pc.setLocalDescription(new SdpAdapter() {
                    @Override
                    public void onSetSuccess() {
                        sdpBusy.set(false);
                        NativeCallLogger.i("NATIVE_ACTIVE_OFFER_SENT", "");
                        SessionDescription offer = sessionDescription;
                        main.post(() -> {
                            if (callbacks != null) callbacks.onLocalSdp(offer, "active");
                        });
                    }

                    @Override
                    public void onSetFailure(String error) {
                        sdpBusy.set(false);
                        NativeCallLogger.w("NATIVE_ACTIVE_OFFER_SET_FAIL", "", new Exception(error));
                    }
                }, sessionDescription);
            }

            @Override
            public void onCreateFailure(String error) {
                sdpBusy.set(false);
                NativeCallLogger.w("NATIVE_ACTIVE_OFFER_CREATE_FAIL", "", new Exception(error));
            }
        }, new MediaConstraints());
    }

    /** Safe SDP fingerprint for logs — never logs full SDP. */
    private static String sdpSummary(String sdp) {
        if (sdp == null) return "sdp=null";
        int audio = 0;
        int video = 0;
        for (String line : sdp.split("\n")) {
            if (line.startsWith("m=audio")) audio++;
            else if (line.startsWith("m=video")) video++;
        }
        return "bytes=" + sdp.length() + " mAudio=" + audio + " mVideo=" + video;
    }

    /** Replace outbound camera with screen track — no SDP renegotiation. */
    public VideoTrack startScreenShare(Intent projectionData) {
        if (pc == null || factory == null || eglBase == null || projectionData == null) {
            throw new IllegalStateException("PC not ready");
        }
        if (screenSharing) {
            return screen.getTrack();
        }
        VideoTrack screenTrack = screen.start(
            app,
            factory,
            eglBase.getEglBaseContext(),
            projectionData,
            () -> main.post(this::stopScreenShare)
        );
        RtpSender sender = findVideoSender();
        if (sender == null) {
            screen.stop();
            throw new IllegalStateException("no video sender");
        }
        sender.setTrack(screenTrack, false);
        camera.stop();
        screenSharing = true;
        NativeCallLogger.i("NATIVE_SCREEN_SHARE_STARTED", "");
        main.post(() -> {
            if (callbacks != null) callbacks.onLocalVideoTrack(screenTrack);
        });
        return screenTrack;
    }

    /** Stop screen share and restore camera (respects cameraEnabled). */
    public VideoTrack stopScreenShare() {
        if (!screenSharing) {
            if (screen.isStarted()) screen.stop();
            return camera.getTrack();
        }
        screenSharing = false;
        VideoTrack cameraTrack = null;
        try {
            if (pc == null || factory == null || eglBase == null) {
                screen.stop();
                return null;
            }
            if (!camera.isStarted()) {
                cameraTrack = camera.start(app, factory, eglBase.getEglBaseContext(), frontCamera);
            } else {
                cameraTrack = camera.getTrack();
            }
            if (cameraTrack != null) {
                cameraTrack.setEnabled(cameraEnabled);
                RtpSender sender = findVideoSender();
                if (sender != null) {
                    sender.setTrack(cameraTrack, false);
                }
            }
        } catch (Exception e) {
            NativeCallLogger.e("NATIVE_SCREEN_RESTORE_CAMERA_FAIL", "", e);
        }
        screen.stop();
        NativeCallLogger.i("NATIVE_SCREEN_SHARE_STOPPED", "");
        final VideoTrack notify = cameraTrack;
        main.post(() -> {
            if (callbacks != null && notify != null) callbacks.onLocalVideoTrack(notify);
        });
        return cameraTrack;
    }

    public boolean isScreenSharing() {
        return screenSharing;
    }

    public void setCameraEnabled(boolean enabled) {
        cameraEnabled = enabled;
        if (screenSharing) {
            VideoTrack st = screen.getTrack();
            if (st != null) st.setEnabled(enabled);
            return;
        }
        camera.setEnabled(enabled);
    }

    private RtpSender findVideoSender() {
        if (videoSender != null) return videoSender;
        if (pc == null) return null;
        for (RtpTransceiver t : pc.getTransceivers()) {
            if (t.getMediaType() == MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO) {
                videoSender = t.getSender();
                return videoSender;
            }
        }
        return null;
    }

    public void dispose() {
        screenSharing = false;
        screen.stop();
        camera.stop();
        audio.stop();
        videoSender = null;
        if (pc != null) {
            pc.dispose();
            pc = null;
        }
        pcCreated.set(false);
        pendingRemoteIce.clear();
        // Keep factory/egl for process lifetime; Activity releases renderers separately.
    }

    private void flushRemoteIce() {
        if (pc == null) return;
        for (IceCandidate c : pendingRemoteIce) {
            pc.addIceCandidate(c);
        }
        pendingRemoteIce.clear();
    }

    private static List<PeerConnection.IceServer> defaultStun() {
        return Collections.singletonList(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer()
        );
    }

    private static List<PeerConnection.IceServer> fetchIce(String baseUrl, String token) throws Exception {
        String url = baseUrl.endsWith("/") ? baseUrl + "api/ice-servers" : baseUrl + "/api/ice-servers";
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod("GET");
        conn.setRequestProperty("Authorization", "Bearer " + token);
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(8000);
        int code = conn.getResponseCode();
        if (code != 200) throw new IllegalStateException("ice http " + code);
        StringBuilder sb = new StringBuilder();
        try (BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) sb.append(line);
        }
        JSONObject root = new JSONObject(sb.toString());
        JSONArray arr = root.optJSONArray("iceServers");
        List<PeerConnection.IceServer> out = new ArrayList<>();
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject s = arr.getJSONObject(i);
                Object urls = s.opt("urls");
                PeerConnection.IceServer.Builder b;
                if (urls instanceof JSONArray) {
                    List<String> list = new ArrayList<>();
                    JSONArray u = (JSONArray) urls;
                    for (int j = 0; j < u.length(); j++) list.add(u.getString(j));
                    b = PeerConnection.IceServer.builder(list);
                } else {
                    b = PeerConnection.IceServer.builder(String.valueOf(urls));
                }
                if (s.has("username")) b.setUsername(s.optString("username"));
                if (s.has("credential")) b.setPassword(s.optString("credential"));
                out.add(b.createIceServer());
            }
        }
        return out.isEmpty() ? defaultStun() : out;
    }

    private abstract static class SdpAdapter implements SdpObserver {
        @Override public void onCreateSuccess(SessionDescription sessionDescription) {}
        @Override public void onSetSuccess() {}
        @Override public void onCreateFailure(String s) {
            NativeCallLogger.i("SDP_CREATE_FAIL", "", s);
        }
        @Override public void onSetFailure(String s) {
            NativeCallLogger.i("SDP_SET_FAIL", "", s);
        }
    }
}
