package com.coachman.app.calls;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class CallActionStoreTest {

    @Test
    public void ttl_expiresAfter90Seconds() {
        long now = 1_000_000L;
        assertFalse(CallActionStore.isExpired(now - 1_000L, now));
        assertFalse(CallActionStore.isExpired(now - CallActionStore.TTL_MS, now));
        assertTrue(CallActionStore.isExpired(now - CallActionStore.TTL_MS - 1, now));
        assertTrue(CallActionStore.isExpired(0, now));
    }
}
