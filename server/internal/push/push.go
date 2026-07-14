package push

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
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
}

func NewSender(st *store.Store, publicKey, privateKey, subject, pwaManifestID string) *Sender {
	return &Sender{
		store:        st,
		vapidPublic:  strings.TrimSpace(publicKey),
		vapidPrivate: strings.TrimSpace(privateKey),
		vapidSubject: normalizeVAPIDSubject(subject, pwaManifestID),
	}
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

func (s *Sender) Enabled() bool {
	return s.vapidPublic != "" && s.vapidPrivate != "" && s.vapidSubject != ""
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

func (s *Sender) NotifyNewMessage(recipientIDs []string, senderID, chatID, msgType string) {
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
	if msgType == "call" {
		body = "Видеозвонок"
	}
	if msgType == "list" {
		body = "Изменение в списке"
	}

	for _, userID := range recipientIDs {
		if userID == senderID {
			continue
		}
		subs, err := s.store.ListPushSubscriptions(userID)
		if err != nil {
			continue
		}
		if len(subs) == 0 {
			continue
		}
		badge, err := s.store.IncrementPushBadge(userID)
		if err != nil {
			badge = 1
		}
		userData, err := json.Marshal(payload{
			Title:  title,
			Body:   body,
			ChatID: chatID,
			Badge:  badge,
			TS:     time.Now().UnixMilli(),
		})
		if err != nil {
			continue
		}
		for _, sub := range subs {
			go s.send(sub, userData, 3600)
		}
	}
}

// NotifyIncomingCall wakes the callee's device when the app is closed or backgrounded.
func (s *Sender) NotifyIncomingCall(recipientIDs []string, fromUserID, chatID, callID string) {
	if !s.Enabled() {
		return
	}

	from, err := s.store.GetUser(fromUserID)
	name := "Собеседник"
	if err == nil && from != nil && from.Username != "" {
		name = strings.TrimPrefix(from.Username, "@")
	}

	userData, err := json.Marshal(payload{
		Title:  "Входящий видеозвонок",
		Body:   name,
		ChatID: chatID,
		CallID: callID,
		FromID: fromUserID,
		Type:   "incoming-call",
		TS:     time.Now().UnixMilli(),
	})
	if err != nil {
		return
	}

	for _, userID := range recipientIDs {
		if userID == fromUserID {
			continue
		}
		subs, err := s.store.ListPushSubscriptions(userID)
		if err != nil || len(subs) == 0 {
			continue
		}
		slog.Info("webrtc call push", "callId", callID, "to", userID, "subs", len(subs))
		for _, sub := range subs {
			go s.send(sub, userData, 60)
		}
	}
}

// NotifyCallEnded clears ringing UI on devices that never received the WS hangup
// (app killed / offline). Replaces the incoming-call notification via the same tag.
func (s *Sender) NotifyCallEnded(recipientIDs []string, fromUserID, chatID, callID string) {
	if !s.Enabled() || callID == "" {
		return
	}

	userData, err := json.Marshal(payload{
		Title:  "Звонок завершён",
		Body:   "Входящий вызов отменён",
		ChatID: chatID,
		CallID: callID,
		FromID: fromUserID,
		Type:   "call-ended",
		TS:     time.Now().UnixMilli(),
	})
	if err != nil {
		return
	}

	for _, userID := range recipientIDs {
		if userID == fromUserID {
			continue
		}
		subs, err := s.store.ListPushSubscriptions(userID)
		if err != nil || len(subs) == 0 {
			continue
		}
		slog.Info("webrtc call ended push", "callId", callID, "to", userID, "subs", len(subs))
		for _, sub := range subs {
			// Short TTL: only useful while the ring UI might still be cached.
			go s.send(sub, userData, 30)
		}
	}
}

func (s *Sender) send(sub store.PushSubscription, data []byte, ttl int) {
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
