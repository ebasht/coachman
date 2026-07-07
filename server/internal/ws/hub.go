package ws

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"

	"github.com/redis/go-redis/v9"
	"nhooyr.io/websocket"

	"coachman/server/internal/auth"
	"coachman/server/internal/store"
)

type Hub struct {
	mu        sync.RWMutex
	clients   map[string]map[*websocket.Conn]struct{}
	store     *store.Store
	jwtSecret string
	redis     *redis.Client
	cancel    context.CancelFunc
}

func NewHub(st *store.Store, jwtSecret string, rdb *redis.Client) *Hub {
	h := &Hub{
		clients:   make(map[string]map[*websocket.Conn]struct{}),
		store:     st,
		jwtSecret: jwtSecret,
		redis:     rdb,
	}
	if rdb != nil {
		ctx, cancel := context.WithCancel(context.Background())
		h.cancel = cancel
		go h.runRedisSubscriber(ctx)
		slog.Info("redis pub/sub enabled for websocket")
	}
	return h
}

func (h *Hub) Close() {
	if h.cancel != nil {
		h.cancel()
	}
	if h.redis != nil {
		_ = h.redis.Close()
	}
}

func (h *Hub) Handle(w http.ResponseWriter, r *http.Request) {
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
			if userID != "" {
				h.unregister(userID, conn)
			}
			userID = claims.UserID
			h.register(userID, conn)

		case "message":
			if userID == "" {
				continue
			}
			var payload struct {
				ChatID string `json:"chatId"`
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
			out, _ := json.Marshal(map[string]any{
				"type":    "message",
				"payload": msg.Payload,
			})
			h.dispatch(memberIDs, out)
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
	defer h.mu.Unlock()
	if h.clients[userID] == nil {
		h.clients[userID] = make(map[*websocket.Conn]struct{})
	}
	h.clients[userID][conn] = struct{}{}
}

func (h *Hub) unregister(userID string, conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if conns, ok := h.clients[userID]; ok {
		delete(conns, conn)
		if len(conns) == 0 {
			delete(h.clients, userID)
		}
	}
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
