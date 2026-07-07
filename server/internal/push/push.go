package push

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"

	"coachman/server/internal/store"
)

type Sender struct {
	store        *store.Store
	vapidPublic  string
	vapidPrivate string
	vapidSubject string
	manifestID   string
}

func NewSender(st *store.Store, publicKey, privateKey, subject, manifestID string) *Sender {
	return &Sender{
		store:        st,
		vapidPublic:  strings.TrimSpace(publicKey),
		vapidPrivate: strings.TrimSpace(privateKey),
		vapidSubject: strings.TrimSpace(subject),
		manifestID:   strings.TrimSpace(manifestID),
	}
}

func (s *Sender) Enabled() bool {
	return s.vapidPublic != "" && s.vapidPrivate != "" && s.vapidSubject != ""
}

func (s *Sender) PublicKey() string {
	return s.vapidPublic
}

type payload struct {
	Title  string `json:"title"`
	Body   string `json:"body"`
	ChatID string `json:"chatId"`
	Badge  int    `json:"badge,omitempty"`
	TS     int64  `json:"ts,omitempty"`
}

func (s *Sender) NotifyNewMessage(recipientIDs []string, senderID, chatID string) {
	if !s.Enabled() {
		return
	}

	sender, err := s.store.GetUser(senderID)
	senderName := ""
	if err == nil && sender != nil {
		senderName = sender.Username
	}

	body := "Новое сообщение"
	if senderName != "" {
		body = "@" + senderName
	}

	data, err := json.Marshal(payload{
		Title:  "Ямщик",
		Body:   body,
		ChatID: chatID,
		Badge:  1,
		TS:     time.Now().UnixMilli(),
	})
	if err != nil {
		return
	}

	for _, userID := range recipientIDs {
		if userID == senderID {
			continue
		}
		subs, err := s.store.ListPushSubscriptions(userID)
		if err != nil {
			continue
		}
		for _, sub := range subs {
			go s.send(sub, data)
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
		return
	}

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	slog.Warn("push rejected", "status", resp.StatusCode, "endpoint", sub.Endpoint, "body", string(body))

	if resp.StatusCode == http.StatusGone || resp.StatusCode == http.StatusNotFound {
		_ = s.store.DeletePushSubscriptionsByEndpoint(sub.Endpoint)
	}
}

func (s *Sender) optionsFor(endpoint string) *webpush.Options {
	opts := &webpush.Options{
		Subscriber:      s.vapidSubject,
		VAPIDPublicKey:  s.vapidPublic,
		VAPIDPrivateKey: s.vapidPrivate,
		TTL:             3600,
		Urgency:         webpush.UrgencyHigh,
	}
	if strings.Contains(endpoint, "push.apple.com") {
		opts.Topic = s.manifestID
		if opts.Topic == "" {
			opts.Topic = "/"
		}
	}
	return opts
}
