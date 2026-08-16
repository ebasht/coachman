package ws

import (
	"bytes"
	"context"
	"encoding/json"
	"time"

	"nhooyr.io/websocket"
)

const (
	pendingEventTTL = 5 * time.Minute
	pendingEventMax = 64
)

type pendingEvent struct {
	data []byte
	at   time.Time
}

func isDurableWSEvent(data []byte) bool {
	var peek struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(data, &peek) != nil {
		return false
	}
	switch peek.Type {
	case "message", "message_deleted", "chat_cleared":
		return true
	default:
		return false
	}
}

func (h *Hub) enqueuePendingEvent(userID string, data []byte) {
	if userID == "" || len(data) == 0 || !isDurableWSEvent(data) {
		return
	}
	now := time.Now()
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.pendingEvents == nil {
		h.pendingEvents = make(map[string][]pendingEvent)
	}
	live := h.pendingEvents[userID][:0]
	for _, ev := range h.pendingEvents[userID] {
		if now.Sub(ev.at) < pendingEventTTL {
			live = append(live, ev)
		}
	}
	for _, ev := range live {
		if bytes.Equal(ev.data, data) {
			h.pendingEvents[userID] = live
			return
		}
	}
	live = append(live, pendingEvent{data: append([]byte(nil), data...), at: now})
	if len(live) > pendingEventMax {
		live = live[len(live)-pendingEventMax:]
	}
	h.pendingEvents[userID] = live
}

func (h *Hub) takePendingEvents(userID string) [][]byte {
	now := time.Now()
	h.mu.Lock()
	q := h.pendingEvents[userID]
	delete(h.pendingEvents, userID)
	h.mu.Unlock()
	out := make([][]byte, 0, len(q))
	for _, ev := range q {
		if now.Sub(ev.at) < pendingEventTTL {
			out = append(out, ev.data)
		}
	}
	return out
}

func (h *Hub) flushPendingEvents(userID string, conn *websocket.Conn) {
	for _, data := range h.takePendingEvents(userID) {
		ctx, cancel := context.WithTimeout(context.Background(), wsWriteTimeout)
		_ = conn.Write(ctx, websocket.MessageText, data)
		cancel()
	}
}
