package com.coachman.app.calls.nativewebrtc;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;

/**
 * Routes call audio to the loudspeaker at communication volume.
 * Without this, WebRTC / WebView often stay on the earpiece and sound "whisper quiet".
 * leaveCall() must fully drop HFP/SCO so car hands-free clears after hangup.
 */
public final class NativeCallAudioRouter {
    private static AudioManager audioManager;
    private static AudioFocusRequest focusRequest;
    private static boolean active;
    private static int savedMode = AudioManager.MODE_NORMAL;
    private static boolean savedSpeakerphone;

    private NativeCallAudioRouter() {}

    /** Enter in-call routing: communication mode + speakerphone (video calls). */
    public static synchronized void enterCall(Context context, boolean speakerphone) {
        Context app = context.getApplicationContext();
        AudioManager am = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return;
        audioManager = am;

        if (!active) {
            savedMode = am.getMode();
            savedSpeakerphone = am.isSpeakerphoneOn();
        }

        requestFocus(am);

        try {
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
        } catch (Exception e) {
            NativeCallLogger.w("AUDIO_MODE_FAIL", "", e);
        }

        try {
            // Deprecated but still the reliable way to force loudspeaker for WebRTC on many OEMs.
            am.setSpeakerphoneOn(speakerphone);
        } catch (Exception e) {
            NativeCallLogger.w("AUDIO_SPEAKER_FAIL", "", e);
        }

        // If voice-call stream is near mute, bump it — users usually have media loud and call quiet.
        try {
            int stream = AudioManager.STREAM_VOICE_CALL;
            int max = am.getStreamMaxVolume(stream);
            int cur = am.getStreamVolume(stream);
            int floor = Math.max(1, (int) Math.round(max * 0.55));
            if (max > 0 && cur < floor) {
                am.setStreamVolume(stream, floor, 0);
                NativeCallLogger.i(
                    "AUDIO_VOLUME_BUMP",
                    "stream=" + stream + " from=" + cur + " to=" + floor + " max=" + max
                );
            }
        } catch (Exception e) {
            NativeCallLogger.w("AUDIO_VOLUME_FAIL", "", e);
        }

        active = true;
        NativeCallLogger.i(
            "AUDIO_ROUTE_ENTER",
            "speaker=" + speakerphone + " mode=" + am.getMode()
        );
    }

    /** Restore normal audio after the call ends (drops car Bluetooth HFP/SCO). */
    public static synchronized void leaveCall() {
        leaveCall(null);
    }

    public static synchronized void leaveCall(Context context) {
        AudioManager am = audioManager;
        if (am == null && context != null) {
            try {
                am = (AudioManager) context.getApplicationContext()
                    .getSystemService(Context.AUDIO_SERVICE);
            } catch (Exception ignored) {
            }
        }
        if (am == null) {
            active = false;
            focusRequest = null;
            return;
        }

        abandonFocus(am);

        // Car/head unit keeps "active call" while SCO/HFP is up — stop explicitly.
        try {
            if (am.isBluetoothScoOn()) {
                am.setBluetoothScoOn(false);
            }
        } catch (Exception ignored) {
        }
        try {
            am.stopBluetoothSco();
        } catch (Exception ignored) {
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                am.clearCommunicationDevice();
            } catch (Exception ignored) {
            }
        }

        try {
            am.setSpeakerphoneOn(false);
        } catch (Exception ignored) {
        }

        // Always force NORMAL — savedMode can be wrong if enterCall raced or was nested.
        try {
            am.setMode(AudioManager.MODE_NORMAL);
        } catch (Exception ignored) {
        }

        try {
            if (savedSpeakerphone) {
                am.setSpeakerphoneOn(true);
            }
        } catch (Exception ignored) {
        }

        active = false;
        audioManager = null;
        savedMode = AudioManager.MODE_NORMAL;
        savedSpeakerphone = false;
        NativeCallLogger.i("AUDIO_ROUTE_LEAVE", "mode=" + am.getMode()
            + " sco=" + safeSco(am));
    }

    private static String safeSco(AudioManager am) {
        try {
            return String.valueOf(am.isBluetoothScoOn());
        } catch (Exception e) {
            return "?";
        }
    }

    public static synchronized boolean isActive() {
        return active;
    }

    private static void requestFocus(AudioManager am) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (focusRequest == null) {
                    AudioAttributes attrs = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build();
                    focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                        .setAudioAttributes(attrs)
                        .setAcceptsDelayedFocusGain(true)
                        .setOnAudioFocusChangeListener(focusChange -> {
                            /* keep call audio; no ducking needed for 1:1 */
                        })
                        .build();
                }
                am.requestAudioFocus(focusRequest);
            } else {
                am.requestAudioFocus(
                    null,
                    AudioManager.STREAM_VOICE_CALL,
                    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
                );
            }
        } catch (Exception e) {
            NativeCallLogger.w("AUDIO_FOCUS_FAIL", "", e);
        }
    }

    private static void abandonFocus(AudioManager am) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (focusRequest != null) {
                    am.abandonAudioFocusRequest(focusRequest);
                }
            } else {
                am.abandonAudioFocus(null);
            }
        } catch (Exception ignored) {
        }
        focusRequest = null;
    }
}
