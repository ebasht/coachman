package push

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"

	"coachman/server/internal/store"
)

const fcmScope = "https://www.googleapis.com/auth/firebase.messaging"

type fcmClient struct {
	projectID string
	credsJSON []byte
	http      *http.Client
	mu        sync.Mutex
	tokenSrc  oauth2.TokenSource
}

func newFCMClient(projectID, serviceAccountJSONOrPath string) (*fcmClient, error) {
	projectID = strings.TrimSpace(projectID)
	raw := strings.TrimSpace(serviceAccountJSONOrPath)
	if projectID == "" || raw == "" {
		return nil, nil
	}
	data := []byte(raw)
	if !strings.HasPrefix(raw, "{") {
		b, err := os.ReadFile(raw)
		if err != nil {
			return nil, fmt.Errorf("read FCM service account: %w", err)
		}
		data = b
	}
	creds, err := google.CredentialsFromJSON(context.Background(), data, fcmScope)
	if err != nil {
		return nil, fmt.Errorf("parse FCM credentials: %w", err)
	}
	return &fcmClient{
		projectID: projectID,
		credsJSON: data,
		http:      &http.Client{Timeout: 15 * time.Second},
		tokenSrc:  creds.TokenSource,
	}, nil
}

func (c *fcmClient) enabled() bool {
	return c != nil && c.projectID != "" && len(c.credsJSON) > 0
}

type fcmMessage struct {
	Message fcmMessageBody `json:"message"`
}

type fcmMessageBody struct {
	Token        string            `json:"token"`
	Data         map[string]string `json:"data,omitempty"`
	Notification *fcmNotification  `json:"notification,omitempty"`
	Android      *fcmAndroidConfig `json:"android,omitempty"`
}

type fcmNotification struct {
	Title string `json:"title,omitempty"`
	Body  string `json:"body,omitempty"`
}

type fcmAndroidConfig struct {
	Priority     string                 `json:"priority,omitempty"`
	TTL          string                 `json:"ttl,omitempty"`
	Notification *fcmAndroidNotification `json:"notification,omitempty"`
}

type fcmAndroidNotification struct {
	ChannelID            string `json:"channel_id,omitempty"`
	NotificationPriority string `json:"notification_priority,omitempty"`
	Sound                string `json:"sound,omitempty"`
	Tag                  string `json:"tag,omitempty"`
	DefaultVibrateTimings bool  `json:"default_vibrate_timings,omitempty"`
}

func (c *fcmClient) send(ctx context.Context, token string, data map[string]string, title, body string, ttlSeconds int, callTag string) error {
	if !c.enabled() || token == "" {
		return nil
	}
	c.mu.Lock()
	ts := c.tokenSrc
	c.mu.Unlock()
	tok, err := ts.Token()
	if err != nil {
		return fmt.Errorf("fcm token: %w", err)
	}

	msg := fcmMessage{Message: fcmMessageBody{
		Token: token,
		Data:  data,
		Android: &fcmAndroidConfig{
			Priority: "HIGH",
		},
	}}
	if ttlSeconds > 0 {
		msg.Message.Android.TTL = fmt.Sprintf("%ds", ttlSeconds)
	}
	if title != "" || body != "" {
		msg.Message.Notification = &fcmNotification{Title: title, Body: body}
		msg.Message.Android.Notification = &fcmAndroidNotification{
			ChannelID:              "incoming_calls",
			NotificationPriority:   "PRIORITY_MAX",
			Sound:                  "default",
			Tag:                    callTag,
			DefaultVibrateTimings:  true,
		}
	}

	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	url := fmt.Sprintf("https://fcm.googleapis.com/v1/projects/%s/messages:send", c.projectID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+tok.AccessToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	return &fcmHTTPError{Status: resp.StatusCode, Body: string(respBody)}
}

type fcmHTTPError struct {
	Status int
	Body   string
}

func (e *fcmHTTPError) Error() string {
	return fmt.Sprintf("fcm http %d: %s", e.Status, e.Body)
}

func (s *Sender) sendFCM(token store.DevicePushToken, data map[string]string, title, body string, ttlSeconds int, callTag string) {
	if s.fcm == nil || !s.fcm.enabled() {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tokenTail := token.Token
	if len(tokenTail) > 12 {
		tokenTail = "…" + tokenTail[len(tokenTail)-8:]
	}
	err := s.fcm.send(ctx, token.Token, data, title, body, ttlSeconds, callTag)
	if err == nil {
		slog.Info("fcm delivered",
			"platform", token.Platform,
			"type", data["type"],
			"token", tokenTail,
			"tag", callTag,
		)
		return
	}
	slog.Warn("fcm send failed",
		"err", err,
		"platform", token.Platform,
		"type", data["type"],
		"token", tokenTail,
	)
	if he, ok := err.(*fcmHTTPError); ok && (he.Status == http.StatusNotFound || he.Status == http.StatusGone ||
		strings.Contains(he.Body, "UNREGISTERED") || strings.Contains(he.Body, "NOT_FOUND")) {
		_ = s.store.DeleteDevicePushTokenByToken(token.Token)
		slog.Info("fcm token removed", "token", tokenTail, "status", he.Status)
	}
}
