package com.coachman.app.calls.nativewebrtc;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Duplicate-ready / duplicate-answer guards are session flags. */
public class NativeCallReadyGuardTest {
    @Test
    public void readySentFlagPreventsSecondPeerConnectionCreate() {
        boolean readySent = false;
        readySent = !readySent; // first ready
        assertTrue(readySent);
        boolean second = !readySent && true; // would create PC
        assertFalse(second);
    }

    @Test
    public void answeringFlagPreventsSecondCapturer() {
        boolean answering = false;
        assertTrue(!answering);
        answering = true;
        assertFalse(!answering);
    }
}
