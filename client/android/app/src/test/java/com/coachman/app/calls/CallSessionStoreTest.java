package com.coachman.app.calls;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class CallSessionStoreTest {
    @Test
    public void ttlMatchesActionStore() {
        long now = 1_000_000L;
        assertFalse(CallActionStore.isExpired(now - 1_000L, now));
        assertTrue(CallActionStore.isExpired(now - CallSessionStore.TTL_MS - 1, now));
    }
}
