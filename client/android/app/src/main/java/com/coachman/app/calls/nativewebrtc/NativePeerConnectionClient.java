package com.coachman.app.calls.nativewebrtc;

import android.content.Context;
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
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpReceiver;
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
    }

    private static final AtomicBoolean factoryInit = new AtomicBoolean(false);

    private final Context app;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final NativeCameraController camera = new NativeCameraController();
    private final NativeAudioController audio = new NativeAudioController();
    private final AtomicBoolean pcCreated = new AtomicBoolean(false);

    private EglBase eglBase;
    private PeerConnectionFactory factory;
    private PeerConnection pc;
    private Callbacks callbacks;
    private String stage = "preview";
    private final List<IceCandidate> pendingRemoteIce = new ArrayList<>();

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
            JavaAudioDeviceModule adm = JavaAudioDeviceModule.builder(app).createAudioDeviceModule();
            factory = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(new DefaultVideoEncoderFactory(eglBase.getEglBaseContext(), true, true))
                .setVideoDecoderFactory(new DefaultVideoDecoderFactory(eglBase.getEglBaseContext()))
                .setAudioDeviceModule(adm)
                .createPeerConnectionFactory();
        }
    }

    /** Create preview PC once (recvonly video, inactive audio). */
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
            @Override public void onSignalingChange(PeerConnection.SignalingState signalingState) {}
            @Override public void onIceConnectionChange(PeerConnection.IceConnectionState iceConnectionState) {}
            @Override public void onIceConnectionReceivingChange(boolean b) {}
            @Override public void onIceGatheringChange(PeerConnection.IceGatheringState iceGatheringState) {}
            @Override
            public void onIceCandidate(IceCandidate iceCandidate) {
                if (callbacks != null) callbacks.onIceCandidate(iceCandidate, stage);
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
                    if (callbacks != null) callbacks.onRemoteVideoTrack(vt);
                }
            }
            @Override
            public void onConnectionChange(PeerConnection.PeerConnectionState newState) {
                if (callbacks != null) callbacks.onConnectionChange(newState);
            }
        });
        if (pc == null) {
            if (callbacks != null) callbacks.onError("PeerConnection create failed");
            return;
        }
        pc.addTransceiver(
            org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO,
            new RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.RECV_ONLY)
        );
        pc.addTransceiver(
            org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO,
            new RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.INACTIVE)
        );
        pcCreated.set(true);
        stage = "preview";
        NativeCallLogger.i("NATIVE_PREVIEW_PC_READY", "");
    }

    public void setRemoteOffer(String sdp, String offerStage) {
        if (pc == null || sdp == null) return;
        stage = offerStage == null ? "preview" : offerStage;
        SessionDescription offer = new SessionDescription(SessionDescription.Type.OFFER, sdp);
        pc.setRemoteDescription(new SdpAdapter() {
            @Override
            public void onSetSuccess() {
                flushRemoteIce();
                MediaConstraints c = new MediaConstraints();
                pc.createAnswer(new SdpAdapter() {
                    @Override
                    public void onCreateSuccess(SessionDescription sessionDescription) {
                        pc.setLocalDescription(new SdpAdapter() {
                            @Override
                            public void onSetSuccess() {
                                if (callbacks != null) {
                                    callbacks.onLocalSdp(sessionDescription, stage);
                                }
                            }
                        }, sessionDescription);
                    }
                }, c);
            }
        }, offer);
    }

    public void setRemoteAnswer(String sdp) {
        if (pc == null || sdp == null) return;
        pc.setRemoteDescription(new SdpAdapter() {
            @Override
            public void onSetSuccess() {
                flushRemoteIce();
                NativeCallLogger.i("NATIVE_ACTIVE_ANSWER_APPLIED", "");
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

    /** After Answer: start local A/V once, renegotiate sendrecv, create active offer. */
    public void startLocalMediaAndCreateActiveOffer(boolean frontCamera) {
        if (pc == null || factory == null || eglBase == null) {
            if (callbacks != null) callbacks.onError("PC not ready");
            return;
        }
        if (camera.isStarted()) {
            NativeCallLogger.i("NATIVE_CAPTURE_ALREADY", "");
        } else {
            try {
                VideoTrack vt = camera.start(app, factory, eglBase.getEglBaseContext(), frontCamera);
                AudioTrack at = audio.start(factory);
                for (RtpTransceiver t : pc.getTransceivers()) {
                    if (t.getMediaType() == org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO) {
                        t.setDirection(RtpTransceiver.RtpTransceiverDirection.SEND_RECV);
                        t.getSender().setTrack(vt, false);
                    } else if (t.getMediaType() == org.webrtc.MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO) {
                        t.setDirection(RtpTransceiver.RtpTransceiverDirection.SEND_RECV);
                        t.getSender().setTrack(at, false);
                    }
                }
            } catch (Exception e) {
                NativeCallLogger.e("NATIVE_LOCAL_MEDIA_FAIL", "", e);
                if (callbacks != null) callbacks.onError("Camera/mic failed");
                return;
            }
        }
        stage = "active";
        pc.createOffer(new SdpAdapter() {
            @Override
            public void onCreateSuccess(SessionDescription sessionDescription) {
                pc.setLocalDescription(new SdpAdapter() {
                    @Override
                    public void onSetSuccess() {
                        NativeCallLogger.i("NATIVE_ACTIVE_OFFER_SENT", "");
                        if (callbacks != null) callbacks.onLocalSdp(sessionDescription, "active");
                    }
                }, sessionDescription);
            }
        }, new MediaConstraints());
    }

    public void dispose() {
        camera.stop();
        audio.stop();
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
