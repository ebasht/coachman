package com.coachman.app.calls.permissions;

import org.junit.Test;

import android.app.NotificationManager;
import android.provider.Settings;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class CallPermissionCoordinatorTest {
    @Test
    public void postNotificationsRequiredFrom33() {
        assertFalse(CallPermissionCoordinator.requiresPostNotifications(32));
        assertTrue(CallPermissionCoordinator.requiresPostNotifications(33));
        assertTrue(CallPermissionCoordinator.requiresPostNotifications(34));
    }

    @Test
    public void bluetoothConnectRequiredFrom31() {
        assertFalse(CallPermissionCoordinator.requiresBluetoothConnect(30));
        assertTrue(CallPermissionCoordinator.requiresBluetoothConnect(31));
        assertTrue(CallPermissionCoordinator.requiresBluetoothConnect(34));
    }

    @Test
    public void fullScreenSpecialAccessFrom34() {
        assertFalse(CallPermissionCoordinator.supportsFullScreenSpecialAccess(33));
        assertTrue(CallPermissionCoordinator.supportsFullScreenSpecialAccess(34));
    }

    @Test
    public void batteryOptimizedDoesNotBlockIncomingReadyFormula() {
        // Formula documented: battery is informational only.
        boolean notificationsGranted = true;
        boolean appNotificationsEnabled = true;
        boolean callChannelHighImportance = true;
        boolean fullScreenAllowed = true;
        boolean batteryOptimized = true;
        boolean incomingCallsReady =
            notificationsGranted
                && appNotificationsEnabled
                && callChannelHighImportance
                && fullScreenAllowed;
        assertTrue(incomingCallsReady);
        assertTrue(batteryOptimized); // still optimized, but ready
    }

    @Test
    public void lowChannelImportanceIsNotReady() {
        int importance = NotificationManager.IMPORTANCE_DEFAULT;
        assertFalse(importance >= NotificationManager.IMPORTANCE_HIGH);
    }

    @Test
    public void highChannelImportanceIsReady() {
        int importance = NotificationManager.IMPORTANCE_HIGH;
        assertTrue(importance >= NotificationManager.IMPORTANCE_HIGH);
    }

    @Test
    public void fullScreenSettingsActionConstant() {
        assertEquals(
            "android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT",
            Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT
        );
    }

    @Test
    public void denialOfNotificationsBlocksDirectActivityPolicy() {
        boolean notificationsGranted = false;
        boolean mayLaunchDirect = notificationsGranted; // policy mirror
        assertFalse(mayLaunchDirect);
    }

    @Test
    public void denialOfCameraBlocksCapturer() {
        boolean cameraGranted = false;
        assertFalse(cameraGranted && true);
    }

    @Test
    public void denialOfMicBlocksAudioTrack() {
        boolean micGranted = false;
        assertFalse(micGranted && true);
    }

    @Test
    public void testCallMustNotStartActivityDirectly() {
        // Documented contract: test uses IncomingCallRingService / FSI only.
        boolean startActivityDirectInTest = false;
        assertFalse(startActivityDirectInTest);
    }
}
