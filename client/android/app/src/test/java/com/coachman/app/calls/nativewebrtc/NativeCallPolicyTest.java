package com.coachman.app.calls.nativewebrtc;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class NativeCallPolicyTest {
    @Test
    public void cameraAndMicForbiddenBeforeAnswer() {
        assertFalse(NativeCallUnlockPolicy.cameraAllowedBeforeAnswer());
        assertFalse(NativeCallUnlockPolicy.microphoneAllowedBeforeAnswer());
    }

    @Test
    public void rejectAndMissedDoNotOpenMainActivity() {
        assertFalse(NativeCallUnlockPolicy.openMainActivityOnReject());
        assertFalse(NativeCallUnlockPolicy.openMainActivityOnMissed());
    }

    @Test
    public void keyguardOnlyAfterAcceptedWhileLocked() {
        assertTrue(NativeCallUnlockPolicy.needsKeyguard(true, true));
        assertFalse(NativeCallUnlockPolicy.needsKeyguard(true, false));
        assertFalse(NativeCallUnlockPolicy.needsKeyguard(false, true));
    }
}
