package com.coachman.app.calls;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;

import com.coachman.app.MainActivity;
import com.coachman.app.R;

/**
 * Lock-screen FaceTime-style incoming call host.
 * Full-screen WebView runs the existing React/WebRTC call-only UI; native gate covers
 * the WebView until JS reports ready so chats never flash over the keyguard.
 */
public class IncomingCallActivity extends AppCompatActivity {
    private static final String TAG = "IncomingCallActivity";

    public static final String EXTRA_CALL_ID = "coachman_call_id";
    public static final String EXTRA_CHAT_ID = "coachman_chat_id";
    public static final String EXTRA_FROM_USER_ID = "coachman_from_user_id";
    public static final String EXTRA_TITLE = "coachman_title";
    public static final String EXTRA_BODY = "coachman_body";
    public static final String EXTRA_LOCKED_AT_START = "coachman_locked_at_start";

    private static final long RING_TIMEOUT_MS = 55_000L;
    private static volatile IncomingCallActivity activeInstance;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView webView;
    private CallGateView gate;
    private String callId = "";
    private String chatId = "";
    private String fromUserId = "";
    private String title = "";
    private String body = "";
    private boolean lockedAtStart;
    private boolean finished;
    private boolean uiReady;
    private boolean accepted;

    public static void dismissActive(String callId) {
        IncomingCallActivity instance = activeInstance;
        if (instance == null) return;
        if (callId != null && !callId.isEmpty() && !callId.equals(instance.callId)) return;
        instance.runOnUiThread(() -> instance.finishCallUi(false));
    }

    public static boolean isShowingFor(String callId) {
        IncomingCallActivity instance = activeInstance;
        return instance != null
            && !instance.finished
            && callId != null
            && callId.equals(instance.callId);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
        super.onCreate(savedInstanceState);
        activeInstance = this;

        getWindow().addFlags(
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_ALLOW_LOCK_WHILE_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
        );
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);

        setContentView(R.layout.activity_incoming_call_webview);
        bindExtras(getIntent());
        Log.i(TAG, "IncomingCallActivity opened (webview host) callId=" + callId);

        CallSessionStore.put(this, callId, chatId, fromUserId, title, body, lockedAtStart);

        FrameLayout gateHost = findViewById(R.id.incoming_gate_host);
        gate = new CallGateView(this);
        gate.bind(title, body, "Подключение видео…");
        gate.setListener(new CallGateView.Listener() {
            @Override
            public void onAccept() {
                onNativeAccept();
            }

            @Override
            public void onReject() {
                onNativeReject();
            }
        });
        gateHost.addView(
            gate,
            new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        );

        setupWebView();
        loadCallPage();

        handler.postDelayed(() -> {
            if (!finished && !accepted) {
                Log.i(TAG, "ring timeout callId=" + callId);
                IncomingCallRingService.dismissNow(this, callId);
                finishCallUi(false);
            }
        }, RING_TIMEOUT_MS);
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void setupWebView() {
        webView = findViewById(R.id.incoming_webview);
        webView.setBackgroundColor(Color.parseColor("#0F172A"));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1) {
            settings.setMediaPlaybackRequiresUserGesture(false);
        }
        webView.addJavascriptInterface(new Bridge(), "CoachmanAndroidCall");
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    if (request == null) return;
                    // Camera/mic only after Answer; still grant if OS already allowed the app.
                    boolean cam = ContextCompat.checkSelfPermission(
                        IncomingCallActivity.this, Manifest.permission.CAMERA
                    ) == PackageManager.PERMISSION_GRANTED;
                    boolean mic = ContextCompat.checkSelfPermission(
                        IncomingCallActivity.this, Manifest.permission.RECORD_AUDIO
                    ) == PackageManager.PERMISSION_GRANTED;
                    if (cam || mic) {
                        request.grant(request.getResources());
                    } else {
                        request.deny();
                    }
                });
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                Log.i(TAG, "WEBVIEW_READY callId=" + callId);
                injectBootstrap();
            }
        });
    }

    private void loadCallPage() {
        String base = CallServerUrl.resolve(this);
        Uri uri = Uri.parse(base).buildUpon()
            .appendQueryParameter("lockCall", "1")
            .appendQueryParameter("callId", callId)
            .appendQueryParameter("chatId", chatId)
            .appendQueryParameter("fromUserId", fromUserId)
            .appendQueryParameter("title", title)
            .appendQueryParameter("body", body)
            .appendQueryParameter("ts", String.valueOf(System.currentTimeMillis()))
            .build();
        Log.i(TAG, "loading lock-call url callId=" + callId);
        webView.loadUrl(uri.toString());
    }

    private void injectBootstrap() {
        String js =
            "(function(){"
                + "window.__COACHMAN_LOCK_CALL__=Object.assign(window.__COACHMAN_LOCK_CALL__||{},{"
                + "callId:" + json(callId) + ","
                + "chatId:" + json(chatId) + ","
                + "fromUserId:" + json(fromUserId) + ","
                + "title:" + json(title) + ","
                + "body:" + json(body) + ","
                + "nativeOwnsRingtone:true"
                + "});"
                + "if(window.__coachmanLockBootstrap){window.__coachmanLockBootstrap();}"
                + "})();";
        webView.evaluateJavascript(js, null);
    }

    private static String json(String s) {
        if (s == null) return "''";
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n") + "'";
    }

    private void onNativeAccept() {
        if (finished || accepted) return;
        accepted = true;
        Log.i(TAG, "ANSWER_CLICKED (native gate) callId=" + callId);
        IncomingCallRingService.dismissNow(this, callId);
        CallActionStore.put(this, "accept", callId, chatId, fromUserId);
        gate.setActionsEnabled(false);
        gate.setStatus("Соединение…");
        // Ask React to accept; also keep gate until active UI is up.
        if (webView != null) {
            webView.evaluateJavascript(
                "window.__coachmanLockAccept&&window.__coachmanLockAccept();",
                null
            );
        }
        // Ensure camera/mic permission prompts can run inside this Activity.
        requestMediaPermissionsIfNeeded();
    }

    private void onNativeReject() {
        if (finished) return;
        Log.i(TAG, "REJECT_CLICKED (native gate) callId=" + callId);
        IncomingCallRingService.dismissNow(this, callId);
        CallActionStore.put(this, "reject", callId, chatId, fromUserId);
        if (webView != null) {
            webView.evaluateJavascript(
                "window.__coachmanLockReject&&window.__coachmanLockReject();",
                null
            );
        }
        finishCallUi(false);
    }

    private void requestMediaPermissionsIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        boolean cam = checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        boolean mic = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        if (cam && mic) return;
        requestPermissions(
            new String[] { Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO },
            4401
        );
    }

    private void onJsUiReady() {
        uiReady = true;
        if (gate != null) {
            gate.setVisibility(View.GONE);
        }
        Log.i(TAG, "CALL_UI_READY (js) callId=" + callId);
    }

    private void finishCallUi(boolean openAppAfterUnlock) {
        if (finished) return;
        finished = true;
        handler.removeCallbacksAndMessages(null);
        IncomingCallRingService.dismissNow(this, callId);
        CallSessionStore.clearIfCall(this, callId);

        if (openAppAfterUnlock && accepted) {
            KeyguardManager km = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
            boolean locked = km != null && km.isDeviceLocked();
            if (locked && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && km != null) {
                gate.setVisibility(View.VISIBLE);
                gate.showEnded();
                Log.i(TAG, "KEYGUARD_DISMISS_REQUESTED callId=" + callId);
                km.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                    @Override
                    public void onDismissSucceeded() {
                        openMainApp();
                        finish();
                        overridePendingTransition(0, 0);
                    }

                    @Override
                    public void onDismissCancelled() {
                        leaveBehindLock();
                    }

                    @Override
                    public void onDismissError() {
                        leaveBehindLock();
                    }
                });
                return;
            }
            openMainApp();
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(false);
            setTurnScreenOn(false);
        }
        getWindow().clearFlags(
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_ALLOW_LOCK_WHILE_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_SECURE
        );
        finish();
        overridePendingTransition(0, 0);
    }

    private void leaveBehindLock() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(false);
            setTurnScreenOn(false);
        }
        try {
            finishAndRemoveTask();
        } catch (Exception e) {
            finish();
        }
    }

    private void openMainApp() {
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
        );
        try {
            startActivity(open);
        } catch (Exception e) {
            Log.w(TAG, "open MainActivity failed", e);
        }
    }

    private void bindExtras(Intent intent) {
        if (intent == null) return;
        callId = safe(intent.getStringExtra(EXTRA_CALL_ID));
        chatId = safe(intent.getStringExtra(EXTRA_CHAT_ID));
        fromUserId = safe(intent.getStringExtra(EXTRA_FROM_USER_ID));
        title = safe(intent.getStringExtra(EXTRA_TITLE));
        body = safe(intent.getStringExtra(EXTRA_BODY));
        lockedAtStart = intent.getBooleanExtra(EXTRA_LOCKED_AT_START, true);
        if (title.isEmpty()) title = "Входящий видеозвонок";
        if (body.isEmpty()) body = "Собеседник";
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        bindExtras(intent);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        if (activeInstance == this) activeInstance = null;
        super.onDestroy();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // Stay on lock-screen call UI.
    }

    public static Intent createIntent(
        Context context,
        String callId,
        String chatId,
        String fromUserId,
        String title,
        String body,
        boolean lockedAtStart
    ) {
        Intent intent = new Intent(context, IncomingCallActivity.class);
        intent.setFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_NO_USER_ACTION
                | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
        );
        intent.putExtra(EXTRA_CALL_ID, callId);
        intent.putExtra(EXTRA_CHAT_ID, chatId);
        intent.putExtra(EXTRA_FROM_USER_ID, fromUserId);
        intent.putExtra(EXTRA_TITLE, title);
        intent.putExtra(EXTRA_BODY, body);
        intent.putExtra(EXTRA_LOCKED_AT_START, lockedAtStart);
        return intent;
    }

    private static String safe(String v) {
        return v == null ? "" : v;
    }

    private final class Bridge {
        @JavascriptInterface
        public void uiReady() {
            runOnUiThread(() -> onJsUiReady());
        }

        @JavascriptInterface
        public void dismissRing() {
            runOnUiThread(() -> IncomingCallRingService.dismissNow(IncomingCallActivity.this, callId));
        }

        @JavascriptInterface
        public void reject() {
            runOnUiThread(() -> onNativeReject());
        }

        @JavascriptInterface
        public void accept() {
            runOnUiThread(() -> onNativeAccept());
        }

        @JavascriptInterface
        public void callEnded(boolean needsUnlock) {
            runOnUiThread(() -> {
                accepted = accepted || needsUnlock;
                finishCallUi(needsUnlock);
            });
        }

        @JavascriptInterface
        public void log(String msg) {
            Log.i(TAG, "js: " + msg);
        }
    }
}
