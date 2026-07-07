package push

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	webpush "github.com/SherClockHolmes/webpush-go"

	"coachman/server/internal/store"
	"coachman/server/internal/ws"
)

type Sender struct {
	store         *store.Store
	hub           *ws.Hub
	vapidPublic   string
	vapidPrivate  string
	vapidSubject  string
}

func NewSender(st *store.Store, hub *ws.Hub, publicKey, privateKey, subject string) *Sender {
	return &Sender{
		store:        st,
		hub:          hub,
		vapidPublic:  strings.TrimSpace(publicKey),
		vapidPrivate: strings.TrimSpace(privateKey),
		vapidSubject: strings.TrimSpace(subject),
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
	})
	if err != nil {
		return
	}

	for _, userID := range recipientIDs {
		if userID == senderID {
			continue
		}
		if s.hub.IsUserOnline(userID) {
			continue
		}
		subs, err := s.store.ListPushSubscriptions(userID)
		if err != nil {
			continue
		}
		for _, sub := range subs {
			s.send(sub, data)
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

	resp, err := webpush.SendNotification(data, subscription, &webpush.Options{
		Subscriber:      s.vapidSubject,
		VAPIDPublicKey:  s.vapidPublic,
		VAPIDPrivateKey: s.vapidPrivate,
		TTL:             60,
	})
	if err != nil {
		slog.Debug("push send failed", "err", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusGone || resp.StatusCode == http.StatusNotFound {
		_ = s.store.DeletePushSubscriptionsByEndpoint(sub.Endpoint)
	}
}
