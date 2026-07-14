package ws

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"nhooyr.io/websocket"

	"coachman/server/internal/auth"
	"coachman/server/internal/store"
)

func (h *Hub) IsUserOnline(userID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients[userID]) > 0
}

type Hub struct {
	mu             sync.RWMutex
	clients        map[string]map[*websocket.Conn]struct{}
	store          *store.Store
	jwtSecret      string
	allowedOrigins []string
	redis          *redis.Client
	cancel         context.CancelFunc
	callPush       CallPusher
	// pendingInvites: calleeUserID -> callID -> invite payload (for offline / background).
	pendingInvites map[string]map[string]pendingInvite
}

// CallPusher wakes devices for incoming video calls (Web Push).
type CallPusher interface {
	NotifyIncomingCall(recipientIDs []string, fromUserID, chatID, callID string)
}

type pendingInvite struct {
	payload map[string]any
	expires time.Time
}

const pendingCallTTL = 60 * time.Second

func NewHub(st *store.Store, jwtSecret string, rdb *redis.Client, allowedOrigins []string) *Hub {
	h := &Hub{
		clients:        make(map[string]map[*websocket.Conn]struct{}),
		store:          st,
		jwtSecret:      jwtSecret,
		allowedOrigins: allowedOrigins,
		redis:          rdb,
		pendingInvites: make(map[string]map[string]pendingInvite),
	}
	if rdb != nil {
		ctx, cancel := context.WithCancel(context.Background())
		h.cancel = cancel
		go h.runRedisSubscriber(ctx)
		slog.Info("redis pub/sub enabled for websocket")
	}
	return h
}

func (h *Hub) SetCallPusher(p CallPusher) {
	h.callPush = p
}

func (h *Hub) Close() {
	if h.cancel != nil {
		h.cancel()
	}
	if h.redis != nil {
		_ = h.redis.Close()
	}
}

func (h *Hub) originAllowed(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	if len(h.allowedOrigins) == 0 {
		return false
	}
	for _, allowed := range h.allowedOrigins {
		if allowed == "*" || allowed == origin {
			return true
		}
	}
	return false
}

func (h *Hub) Handle(w http.ResponseWriter, r *http.Request) {
	if !h.originAllowed(r) {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		slog.Error("websocket accept", "err", err)
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	var userID string
	ctx := r.Context()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			break
		}

		var msg struct {
			Type    string          `json:"type"`
			Token   string          `json:"token"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "auth":
			claims, err := auth.ParseToken(msg.Token, h.jwtSecret)
			if err != nil {
				continue
			}
			ver, err := h.store.GetTokenVersion(claims.UserID)
			if err != nil || ver != claims.TokenVersion {
				continue
			}
			if userID != "" {
				h.unregister(userID, conn)
			}
			userID = claims.UserID
			h.register(userID, conn)
			h.flushPendingCalls(userID, conn)

		case "typing":
			if userID == "" {
				continue
			}
			var payload struct {
				ChatID   string `json:"chatId"`
				IsTyping bool   `json:"isTyping"`
			}
			if err := json.Unmarshal(msg.Payload, &payload); err != nil || payload.ChatID == "" {
				continue
			}
			member, err := h.store.IsMember(payload.ChatID, userID)
			if err != nil || !member {
				continue
			}
			memberIDs, err := h.store.GetMemberIDs(payload.ChatID)
			if err != nil {
				continue
			}
			h.BroadcastEvent(memberIDs, "typing", map[string]any{
				"chatId":   payload.ChatID,
				"userId":   userID,
				"isTyping": payload.IsTyping,
			})

		case "call":
			if userID == "" {
				continue
			}
			var payload map[string]any
			if err := json.Unmarshal(msg.Payload, &payload); err != nil {
				continue
			}
			chatID, _ := payload["chatId"].(string)
			action, _ := payload["action"].(string)
			callID, _ := payload["callId"].(string)
			if chatID == "" || action == "" || callID == "" {
				continue
			}
			member, err := h.store.IsMember(chatID, userID)
			if err != nil || !member {
				continue
			}
			chatType, err := h.store.GetChatType(chatID)
			if err != nil || chatType != "direct" {
				continue
			}

			if action == "ice-report" {
				ok, _ := payload["ok"].(bool)
				turn, _ := payload["turn"].(bool)
				via, _ := payload["via"].(string)
				localType, _ := payload["localType"].(string)
				remoteType, _ := payload["remoteType"].(string)
				iceState, _ := payload["iceState"].(string)
				if ok {
					slog.Info("webrtc call path ok",
						"callId", callID,
						"chatId", chatID,
						"userId", userID,
						"via", via,
						"turn", turn,
						"localType", localType,
						"remoteType", remoteType,
						"iceState", iceState,
					)
				} else {
					slog.Warn("webrtc call path failed",
						"callId", callID,
						"chatId", chatID,
						"userId", userID,
						"via", via,
						"turn", turn,
						"localType", localType,
						"remoteType", remoteType,
						"iceState", iceState,
					)
				}
				continue
			}

			memberIDs, err := h.store.GetMemberIDs(chatID)
			if err != nil {
				continue
			}
			targets := make([]string, 0, len(memberIDs))
			for _, id := range memberIDs {
				if id != userID {
					targets = append(targets, id)
				}
			}
			if len(targets) == 0 {
				continue
			}
			payload["fromUserId"] = userID
			if action == "invite" || action == "accept" || action == "hangup" || action == "reject" {
				slog.Info("webrtc call signal",
					"action", action,
					"callId", callID,
					"chatId", chatID,
					"userId", userID,
				)
			}
			switch action {
			case "invite":
				h.storePendingInvites(targets, payload)
				if h.callPush != nil {
					h.callPush.NotifyIncomingCall(targets, userID, chatID, callID)
				}
			case "accept", "reject", "hangup":
				h.clearPendingInvite(callID)
			}
			h.BroadcastEvent(targets, "call", payload)
		}
	}

	if userID != "" {
		h.unregister(userID, conn)
	}
}

func (h *Hub) BroadcastEvent(userIDs []string, eventType string, payload any) {
	out, err := json.Marshal(map[string]any{"type": eventType, "payload": payload})
	if err != nil {
		return
	}
	h.dispatch(userIDs, out)
}

func (h *Hub) register(userID string, conn *websocket.Conn) {
	h.mu.Lock()
	first := len(h.clients[userID]) == 0
	if h.clients[userID] == nil {
		h.clients[userID] = make(map[*websocket.Conn]struct{})
	}
	h.clients[userID][conn] = struct{}{}
	h.mu.Unlock()

	if first {
		h.broadcastPresence(userID, true, 0)
	}
}

func (h *Hub) storePendingInvites(calleeIDs []string, payload map[string]any) {
	callID, _ := payload["callId"].(string)
	if callID == "" {
		return
	}
	// Shallow copy so later mutations don't race.
	cp := make(map[string]any, len(payload))
	for k, v := range payload {
		cp[k] = v
	}
	exp := time.Now().Add(pendingCallTTL)
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, uid := range calleeIDs {
		if h.pendingInvites[uid] == nil {
			h.pendingInvites[uid] = make(map[string]pendingInvite)
		}
		h.pendingInvites[uid][callID] = pendingInvite{payload: cp, expires: exp}
	}
}

func (h *Hub) clearPendingInvite(callID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for uid, byCall := range h.pendingInvites {
		delete(byCall, callID)
		if len(byCall) == 0 {
			delete(h.pendingInvites, uid)
		}
	}
}

func (h *Hub) flushPendingCalls(userID string, conn *websocket.Conn) {
	now := time.Now()
	h.mu.Lock()
	byCall := h.pendingInvites[userID]
	var due []map[string]any
	for callID, inv := range byCall {
		if now.After(inv.expires) {
			delete(byCall, callID)
			continue
		}
		due = append(due, inv.payload)
	}
	if len(byCall) == 0 {
		delete(h.pendingInvites, userID)
	}
	h.mu.Unlock()

	for _, payload := range due {
		out, err := json.Marshal(map[string]any{"type": "call", "payload": payload})
		if err != nil {
			continue
		}
		writeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err = conn.Write(writeCtx, websocket.MessageText, out)
		cancel()
		if err != nil {
			slog.Warn("flush pending call", "err", err, "userId", userID)
		} else {
			slog.Info("webrtc pending invite delivered", "userId", userID, "callId", payload["callId"])
		}
	}
}

func (h *Hub) unregister(userID string, conn *websocket.Conn) {
	h.mu.Lock()
	wentOffline := false
	if conns, ok := h.clients[userID]; ok {
		delete(conns, conn)
		if len(conns) == 0 {
			delete(h.clients, userID)
			wentOffline = true
		}
	}
	h.mu.Unlock()

	if wentOffline {
		now := time.Now().UnixMilli()
		_ = h.store.SetUserLastSeen(userID, now)
		h.broadcastPresence(userID, false, now)
	}
}

func (h *Hub) broadcastPresence(userID string, online bool, lastSeenAt int64) {
	peers, err := h.store.GetSharedChatPeerIDs(userID)
	if err != nil || len(peers) == 0 {
		return
	}
	payload := map[string]any{
		"userId": userID,
		"online": online,
	}
	if !online && lastSeenAt > 0 {
		payload["lastSeenAt"] = lastSeenAt
	}
	h.BroadcastEvent(peers, "presence", payload)
}

func (h *Hub) broadcastLocal(memberIDs []string, data []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	ctx := context.Background()
	for _, id := range memberIDs {
		for conn := range h.clients[id] {
			if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
				slog.Debug("ws write failed", "userId", id, "err", err)
			}
		}
	}
}
