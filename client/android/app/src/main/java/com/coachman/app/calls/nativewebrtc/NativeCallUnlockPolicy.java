package com.coachman.app.calls.nativewebrtc;

/** Pure policy helpers for unlock / MainActivity launch rules. */
public final class NativeCallUnlockPolicy {
    private NativeCallUnlockPolicy() {}

    public static boolean needsKeyguard(boolean accepted, boolean deviceLocked) {
        return accepted && deviceLocked;
    }

    public static boolean openMainActivityOnReject() {
        return false;
    }

    public static boolean openMainActivityOnMissed() {
        return false;
    }

    public static boolean cameraAllowedBeforeAnswer() {
        return false;
    }

    public static boolean microphoneAllowedBeforeAnswer() {
        return false;
    }
}
