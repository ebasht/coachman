package ws

import (
	"fmt"
	"testing"
	"time"
)

func TestIsDurableWSEvent(t *testing.T) {
	t.Parallel()
	if !isDurableWSEvent([]byte(`{"type":"message","payload":{}}`)) {
		t.Fatal("message should be durable")
	}
	if isDurableWSEvent([]byte(`{"type":"typing","payload":{}}`)) {
		t.Fatal("typing should not be buffered")
	}
	if isDurableWSEvent([]byte(`not-json`)) {
		t.Fatal("garbage should not be buffered")
	}
}

func TestPendingEventRingAndDedupe(t *testing.T) {
	t.Parallel()
	h := NewHub(nil, "secret", nil, nil)
	overflow := pendingEventMax + 6
	for i := 0; i < overflow; i++ {
		h.enqueuePendingEvent("u1", []byte(fmt.Sprintf(`{"type":"message","payload":{"id":"%d"}}`, i)))
	}
	lastID := overflow - 1
	// duplicate of the last frame is ignored
	h.enqueuePendingEvent("u1", []byte(fmt.Sprintf(`{"type":"message","payload":{"id":"%d"}}`, lastID)))
	got := h.takePendingEvents("u1")
	if len(got) != pendingEventMax {
		t.Fatalf("ring size: got %d want %d", len(got), pendingEventMax)
	}
	wantFirst := overflow - pendingEventMax
	if string(got[0]) != fmt.Sprintf(`{"type":"message","payload":{"id":"%d"}}`, wantFirst) {
		t.Fatalf("oldest kept: %s", got[0])
	}
	if string(got[len(got)-1]) != fmt.Sprintf(`{"type":"message","payload":{"id":"%d"}}`, lastID) {
		t.Fatalf("newest kept: %s", got[len(got)-1])
	}
	if n := len(h.takePendingEvents("u1")); n != 0 {
		t.Fatalf("second take should be empty, got %d", n)
	}
}

func TestPendingEventTTL(t *testing.T) {
	t.Parallel()
	h := NewHub(nil, "secret", nil, nil)
	h.mu.Lock()
	h.pendingEvents["u1"] = []pendingEvent{{
		data: []byte(`{"type":"message","payload":{"id":"old"}}`),
		at:   time.Now().Add(-pendingEventTTL - time.Second),
	}}
	h.mu.Unlock()
	h.enqueuePendingEvent("u1", []byte(`{"type":"message","payload":{"id":"new"}}`))
	got := h.takePendingEvents("u1")
	if len(got) != 1 || string(got[0]) != `{"type":"message","payload":{"id":"new"}}` {
		t.Fatalf("expired not dropped: %#v", got)
	}
}

func TestPendingSkipsNondurable(t *testing.T) {
	t.Parallel()
	h := NewHub(nil, "secret", nil, nil)
	h.enqueuePendingEvent("u1", []byte(`{"type":"presence","payload":{}}`))
	if n := len(h.takePendingEvents("u1")); n != 0 {
		t.Fatalf("presence buffered: %d", n)
	}
}
