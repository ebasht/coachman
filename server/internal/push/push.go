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

func (s *Sender) NotifyNewMessage(recipientIDs []string, senderID, chatID, msgType, pushBody string) {
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
	if preview := truncatePushBody(pushBody); preview != "" {
		body = preview
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
			go s.send(sub, userData)
		}
	}
}

func (s *Sender) send(sub store.PushSubscription, data []byte) {
	subscription := &webpush.Subscription{
		Endpoint: sub.Endpoint,
		Keys: webpush.Keys{
			P256dh: sub.P256dh,
			Auth:   sub.AuthKey,
		},
	}

	resp, err := webpush.SendNotification(data, subscription, s.optionsFor(sub.Endpoint))
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
