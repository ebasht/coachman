package com.coachman.app.calls;

import android.content.Context;
import android.util.AttributeSet;
import android.view.LayoutInflater;
import android.view.MotionEvent;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.TextView;

import androidx.annotation.Nullable;

import com.coachman.app.R;

/**
 * Opaque privacy overlay above the Capacitor WebView during call-only bootstrap.
 * Blocks all touches from reaching chat UI underneath.
 */
public class CallGateView extends FrameLayout {
    public interface Listener {
        void onAccept();
        void onReject();
    }

    private TextView statusView;
    private TextView callerView;
    private View buttonsRow;
    private Listener listener;
    private boolean actionsEnabled = true;

    public CallGateView(Context context) {
        super(context);
        init(context);
    }

    public CallGateView(Context context, @Nullable AttributeSet attrs) {
        super(context, attrs);
        init(context);
    }

    private void init(Context context) {
        setClickable(true);
        setFocusable(true);
        setBackgroundColor(0xFF0F172A);
        LayoutInflater.from(context).inflate(R.layout.activity_incoming_call, this, true);
        statusView = findViewById(R.id.incoming_label);
        callerView = findViewById(R.id.incoming_caller);
        ImageButton decline = findViewById(R.id.btn_decline);
        ImageButton accept = findViewById(R.id.btn_accept);
        buttonsRow = (View) decline.getParent().getParent();
        decline.setOnClickListener(v -> {
            if (actionsEnabled && listener != null) listener.onReject();
        });
        accept.setOnClickListener(v -> {
            if (actionsEnabled && listener != null) listener.onAccept();
        });
    }

    public void setListener(Listener listener) {
        this.listener = listener;
    }

    public void bind(String title, String body, String status) {
        if (callerView != null) {
            callerView.setText(body == null || body.isEmpty() ? "Собеседник" : body);
        }
        if (statusView != null) {
            String label = status != null && !status.isEmpty()
                ? status
                : (title == null || title.isEmpty() ? "Подключение видео…" : title);
            statusView.setText(label);
        }
    }

    public void setStatus(String status) {
        if (statusView != null && status != null) {
            statusView.setText(status);
        }
    }

    public void setActionsEnabled(boolean enabled) {
        actionsEnabled = enabled;
        if (buttonsRow != null) {
            buttonsRow.setVisibility(enabled ? VISIBLE : GONE);
        }
    }

    public void showEnded() {
        setActionsEnabled(false);
        setStatus("Звонок завершён");
    }

    @Override
    public boolean onInterceptTouchEvent(MotionEvent ev) {
        return true;
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        return true;
    }
}
