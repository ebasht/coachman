package push

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	webpush "github.com/SherClockHolmes/webpush-go"

	"coachman/server/internal/store"
)

// Max visible preview length in the notification body (runes).
const maxPushBodyRunes = 120

type Sender struct {
	store        *store.Store
	vapidPublic  string
	vapidPrivate string
	vapidSubject string
	fcm          *fcmClient
}

func NewSender(st *store.Store, publicKey, privateKey, subject, pwaManifestID, fcmProjectID, fcmServiceAccount string) *Sender {
	s := &Sender{
		store:        st,
		vapidPublic:  strings.TrimSpace(publicKey),
		vapidPrivate: strings.TrimSpace(privateKey),
		vapidSubject: normalizeVAPIDSubject(subject, pwaManifestID),
	}
	fcm, err := newFCMClient(fcmProjectID, fcmServiceAccount)
	if err != nil {
		slog.Warn("fcm init failed", "err", err, "projectId", strings.TrimSpace(fcmProjectID))
	} else if fcm == nil {
		if strings.TrimSpace(fcmProjectID) == "" {
			slog.Info("fcm disabled", "reason", "FCM_PROJECT_ID empty")
		} else if strings.TrimSpace(fcmServiceAccount) == "" {
			slog.Info("fcm disabled", "reason", "FCM_SERVICE_ACCOUNT_JSON empty")
		} else {
			slog.Info("fcm disabled", "reason", "not configured")
		}
	} else {
		s.fcm = fcm
		slog.Info("fcm ready", "projectId", strings.TrimSpace(fcmProjectID))
	}
	return s
}

func normalizeVAPIDSubject(subject, pwaManifestID string) string {
	subject = strings.TrimSpace(subject)
	if subject == "" {
		subject = strings.TrimSpace(pwaManifestID)
	}
	if subject == "" || subject == "/" {
		return "https://coachman.local"
	}
	lower := strings.ToLower(subject)
	if strings.HasPrefix(lower, "https://") || strings.HasPrefix(lower, "http://") {
		return strings.TrimSuffix(subject, "/")
	}
	if strings.HasPrefix(lower, "mailto:") {
		return strings.TrimSpace(subject[len("mailto:"):])
	}
	return subject
}

func (s *Sender) webPushEnabled() bool {
	return s.vapidPublic != "" && s.vapidPrivate != "" && s.vapidSubject != ""
}

func (s *Sender) FCMEnabled() bool {
	return s.fcm != nil && s.fcm.enabled()
}

func (s *Sender) Enabled() bool {
	return s.webPushEnabled() || s.FCMEnabled()
}

func (s *Sender) PublicKey() string {
	return s.vapidPublic
}

func (s *Sender) VAPIDSubject() string {
	return s.vapidSubject
}

type payload struct {
	Title  string `json:"title"`
	Body   string `json:"body"`
	ChatID string `json:"chatId"`
	Badge  int    `json:"badge,omitempty"`
	TS     int64  `json:"ts,omitempty"`
	Type   string `json:"type,omitempty"`
	CallID string `json:"callId,omitempty"`
	FromID string `json:"fromUserId,omitempty"`
}

func truncatePushBody(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= maxPushBodyRunes {
		return s
	}
	runes := []rune(s)
	return string(runes[:maxPushBodyRunes-1]) + "…"
}

// NotifyNewMessage alerts or silently bumps the app badge.
// alert=true: show a push notification (text/image/new list item).
// alert=false: badge + chat marker only (call events, list done/delete, etc.).
func (s *Sender) NotifyNewMessage(recipientIDs []string, senderID, chatID, msgType string, alert bool) {
	if !s.Enabled() {
		return
	}

	sender, err := s.store.GetUser(senderID)
	title := "Ямщик"
	if err == nil && sender != nil && sender.Username != "" {
		title = strings.TrimPrefix(sender.Username, "@")
	}

	body := "Новое сообщение"
	if msgType == "image" {
		body = "Фото"
	}
	if msgType == "list" {
		body = "Новый пункт в списке"
	}

	for _, userID := range recipientIDs {
		if userID == senderID {
			continue
		}
		badge, err := s.store.IncrementPushBadge(userID)
		if err != nil {
			badge = 1
		}
		ts := time.Now().UnixMilli()
		if !alert {
			pl := payload{
				ChatID: chatID,
				Badge:  badge,
				TS:     ts,
				Type:   "badge",
			}
			userData, err := json.Marshal(pl)
			if err != nil {
				continue
			}
			if s.webPushEnabled() {
				subs, err := s.store.ListPushSubscriptions(userID)
				if err == nil {
					for _, sub := range subs {
						go s.send(sub, userData, 3600)
					}
				}
			}
			// Data-only FCM — no tray notification; client updates badge / chat unread.
			s.notifyDevices(userID, map[string]string{
				"type":   "badge",
				"chatId": chatID,
				"badge":  fmtInt(badge),
				"ts":     fmtInt64(ts),
			}, "", "", 3600, "")
			continue
		}

		pl := payload{
			Title:  title,
			Body:   body,
			ChatID: chatID,
			Badge:  badge,
			TS:     ts,
			Type:   "message",
		}
		userData, err := json.Marshal(pl)
		if err != nil {
			continue
		}
		if s.webPushEnabled() {
			subs, err := s.store.ListPushSubscriptions(userID)
			if err == nil {
				for _, sub := range subs {
					go s.send(sub, userData, 3600)
				}
			}
		}
		s.notifyDevices(userID, map[string]string{
			"type":   "message",
			"chatId": chatID,
			"title":  title,
			"body":   body,
			"badge":  fmtInt(badge),
			"ts":     fmtInt64(ts),
		}, title, body, 3600, "")
	}
}

// NotifyIncomingCall wakes the callee's device when the app is closed or backgrounded.
func (s *Sender) NotifyIncomingCall(recipientIDs []string, fromUserID, chatID, callID string) {
	if !s.Enabled() {
		slog.Warn("incoming-call push skipped", "reason", "push not enabled", "callId", callID)
		return
	}

	from, err := s.store.GetUser(fromUserID)
	name := "Собеседник"
	if err == nil && from != nil && from.Username != "" {
		name = strings.TrimPrefix(from.Username, "@")
	}

	title := "Входящий видеозвонок"
	ts := time.Now().UnixMilli()
	userData, err := json.Marshal(payload{
		Title:  title,
		Body:   name,
		ChatID: chatID,
		CallID: callID,
		FromID: fromUserID,
		Type:   "incoming-call",
		TS:     ts,
	})
	if err != nil {
		slog.Warn("incoming-call push marshal failed", "err", err, "callId", callID)
		return
	}

	slog.Info("incoming-call push",
		"callId", callID,
		"chatId", chatID,
		"from", fromUserID,
		"recipients", len(recipientIDs),
		"webPush", s.webPushEnabled(),
		"fcm", s.FCMEnabled(),
	)

	for _, userID := range recipientIDs {
		if userID == fromUserID {
			continue
		}
		if s.webPushEnabled() {
			subs, err := s.store.ListPushSubscriptions(userID)
			if err != nil {
				slog.Warn("web push list failed", "to", userID, "err", err, "callId", callID)
			} else if len(subs) == 0 {
				slog.Info("web push no subscriptions", "to", userID, "callId", callID)
			} else {
				slog.Info("webrtc call push", "callId", callID, "to", userID, "subs", len(subs))
				for _, sub := range subs {
					go s.send(sub, userData, 60)
				}
			}
		}
		s.notifyDevices(userID, map[string]string{
			"type":       "incoming-call",
			"chatId":     chatID,
			"callId":     callID,
			"fromUserId": fromUserID,
			"title":      title,
			"body":       name,
			"ts":         fmtInt64(ts),
		}, title, name, 60, "call-"+callID)
	}
}

// NotifyCallEnded clears ringing UI on devices that never received the WS hangup
// (app killed / offline). Replaces the incoming-call notification via the same tag.
func (s *Sender) NotifyCallEnded(recipientIDs []string, fromUserID, chatID, callID string) {
	if !s.Enabled() || callID == "" {
		return
	}

	title := "Звонок завершён"
	body := "Входящий вызов отменён"
	ts := time.Now().UnixMilli()
	userData, err := json.Marshal(payload{
		Title:  title,
		Body:   body,
		ChatID: chatID,
		CallID: callID,
		FromID: fromUserID,
		Type:   "call-ended",
		TS:     ts,
	})
	if err != nil {
		return
	}

	for _, userID := range recipientIDs {
		if userID == fromUserID {
			continue
		}
		if s.webPushEnabled() {
			subs, err := s.store.ListPushSubscriptions(userID)
			if err == nil && len(subs) > 0 {
				slog.Info("webrtc call ended push", "callId", callID, "to", userID, "subs", len(subs))
				for _, sub := range subs {
					// Short TTL: only useful while the ring UI might still be cached.
					go s.send(sub, userData, 30)
				}
			}
		}
		// Same notification tag as incoming-call replaces the ringing alert.
		s.notifyDevices(userID, map[string]string{
			"type":       "call-ended",
			"chatId":     chatID,
			"callId":     callID,
			"fromUserId": fromUserID,
			"title":      title,
			"body":       body,
			"ts":         fmtInt64(ts),
		}, title, body, 30, "call-"+callID)
	}
}

func (s *Sender) notifyDevices(userID string, data map[string]string, title, body string, ttlSeconds int, callTag string) {
	if !s.FCMEnabled() {
		slog.Info("fcm skip", "reason", "fcm not enabled", "type", data["type"], "to", userID)
		return
	}
	tokens, err := s.store.ListDevicePushTokens(userID)
	if err != nil {
		slog.Warn("fcm list tokens failed", "to", userID, "err", err, "type", data["type"])
		return
	}
	if len(tokens) == 0 {
		slog.Info("fcm skip", "reason", "no device tokens", "type", data["type"], "to", userID)
		return
	}
	slog.Info("fcm notify", "type", data["type"], "to", userID, "tokens", len(tokens), "tag", callTag)
	for _, tok := range tokens {
		t := tok
		go s.sendFCM(t, data, title, body, ttlSeconds, callTag)
	}
}

func fmtInt(n int) string {
	return strconv.Itoa(n)
}

func fmtInt64(n int64) string {
	return strconv.FormatInt(n, 10)
}

func (s *Sender) send(sub store.PushSubscription, data []byte, ttl int) {
	if !s.webPushEnabled() {
		return
	}
	subscription := &webpush.Subscription{
		Endpoint: sub.Endpoint,
		Keys: webpush.Keys{
			P256dh: sub.P256dh,
			Auth:   sub.AuthKey,
		},
	}

	opts := s.optionsFor(sub.Endpoint)
	if ttl > 0 {
		opts.TTL = ttl
	}

	resp, err := webpush.SendNotification(data, subscription, opts)
	if err != nil {
		slog.Warn("push send failed", "err", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		slog.Info("push delivered", "status", resp.StatusCode)
		return
	}

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	slog.Warn("push rejected", "status", resp.StatusCode, "endpoint", sub.Endpoint, "body", string(body))

	if resp.StatusCode == http.StatusGone || resp.StatusCode == http.StatusNotFound {
		_ = s.store.DeletePushSubscriptionsByEndpoint(sub.Endpoint)
	}
}

func (s *Sender) optionsFor(endpoint string) *webpush.Options {
	return &webpush.Options{
		Subscriber:      s.vapidSubject,
		VAPIDPublicKey:  s.vapidPublic,
		VAPIDPrivateKey: s.vapidPrivate,
		TTL:             3600,
		Urgency:         webpush.UrgencyHigh,
		// Topic omitted: Apple allows only [A-Za-z0-9_-], max 32 chars.
	}
}
