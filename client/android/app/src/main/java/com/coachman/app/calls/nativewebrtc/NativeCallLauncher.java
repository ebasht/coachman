package com.coachman.app.calls.nativewebrtc;

import android.app.ActivityOptions;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * Best-effort launch of {@link NativeCallActivity} from FCM / FGS / foreground.
 * Unlocked devices suppress notification fullScreenIntent — activity must be
 * started explicitly while the process still has a BAL exemption (high-priority
 * FCM is the most reliable window).
 */
public final class NativeCallLauncher {
    private static final String TAG = "NativeCallLauncher";

    private NativeCallLauncher() {}

    public static void launch(
        Context context,
        String callId,
        String chatId,
        String fromUserId,
        String title,
        String body,
        boolean lockedAtStart
    ) {
        if (context == null || callId == null || callId.isEmpty()) return;
        try {
            Intent intent = NativeCallActivity.createIntent(
                context.getApplicationContext(),
                callId,
                chatId,
                fromUserId,
                title,
                body,
                lockedAtStart,
                false,
                false
            );
            intent.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_CLEAR_TOP
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP
                    | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                    | Intent.FLAG_ACTIVITY_NO_USER_ACTION
            );
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                ActivityOptions opts = ActivityOptions.makeBasic();
                opts.setPendingIntentBackgroundActivityStartMode(
                    ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED
                );
                context.startActivity(intent, opts.toBundle());
            } else {
                context.startActivity(intent);
            }
            Log.i(TAG, "NATIVE_CALL_ACTIVITY_LAUNCHED callId=" + callId);
        } catch (Exception e) {
            Log.e(TAG, "NATIVE_CALL_ACTIVITY_LAUNCH_FAILED callId=" + callId, e);
        }
    }
}
