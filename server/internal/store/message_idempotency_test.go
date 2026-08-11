package store_test

import (
	"fmt"
	"sync"
	"testing"

	"coachman/server/internal/store"
)

// countMessages returns how many rows exist for a chat.
func countMessages(t *testing.T, s *store.Store, chatID string) int {
	t.Helper()
	msgs, err := s.GetMessages(chatID, 0)
	if err != nil {
		t.Fatal(err)
	}
	return len(msgs)
}

// TestSendMessageIdempotencyFirstAndDuplicate covers first create + duplicate
// POST with the same (chat, sender, clientId) returning the existing row.
func TestSendMessageIdempotencyFirstAndDuplicate(t *testing.T) {
	s := newStore(t)
	a := registerBootstrap(t, s, "alice")
	b := registerInvited(t, s, a.ID, "bob")
	chatID, err := s.CreateDirectChat(a.ID, b.ID)
	if err != nil {
		t.Fatal(err)
	}

	clientID := "idem-first-dup-1"

	// First send creates a new row.
	first, created, err := s.SendMessage(chatID, a.ID, "cipher-hello", "iv", "text", nil, clientID, nil, nil)
	if err != nil {
		t.Fatalf("first send: %v", err)
	}
	if !created {
		t.Fatal("first send: expected created=true")
	}
	if first.ID == "" {
		t.Fatal("first send: empty message id")
	}
	if first.ClientID == nil || *first.ClientID != clientID {
		t.Fatalf("first send: clientId = %v", first.ClientID)
	}
	if countMessages(t, s, chatID) != 1 {
		t.Fatalf("after first send: want 1 row, got %d", countMessages(t, s, chatID))
	}

	// Duplicate send with same clientId must not insert another row.
	dup, created2, err := s.SendMessage(chatID, a.ID, "cipher-different-body", "iv2", "text", nil, clientID, nil, nil)
	if err != nil {
		t.Fatalf("duplicate send: %v", err)
	}
	if created2 {
		t.Fatal("duplicate send: expected created=false")
	}
	if dup.ID != first.ID {
		t.Fatalf("duplicate send: want id %s, got %s", first.ID, dup.ID)
	}
	if countMessages(t, s, chatID) != 1 {
		t.Fatalf("after duplicate: want 1 row, got %d", countMessages(t, s, chatID))
	}
}

// TestSendMessageIdempotencyLostACK simulates a successful create whose HTTP
// response never reached the client: the client retries with the same clientId
// and must receive the original message without a second DB row.
func TestSendMessageIdempotencyLostACK(t *testing.T) {
	s := newStore(t)
	a := registerBootstrap(t, s, "alice")
	b := registerInvited(t, s, a.ID, "bob")
	chatID, err := s.CreateDirectChat(a.ID, b.ID)
	if err != nil {
		t.Fatal(err)
	}

	clientID := "idem-lost-ack-1"
	payload := "cipher-lost-ack"

	// Server accepted the write (ACK would have been sent here and "lost").
	acked, created, err := s.SendMessage(chatID, a.ID, payload, "iv", "text", nil, clientID, nil, nil)
	if err != nil || !created {
		t.Fatalf("initial send: err=%v created=%v", err, created)
	}
	// Client discards / never sees acked — only retries with same clientId.
	_ = acked

	retry, created2, err := s.SendMessage(chatID, a.ID, payload, "iv", "text", nil, clientID, nil, nil)
	if err != nil {
		t.Fatalf("lost-ACK retry: %v", err)
	}
	if created2 {
		t.Fatal("lost-ACK retry: expected created=false")
	}
	if retry.ID != acked.ID {
		t.Fatalf("lost-ACK retry: want id %s, got %s", acked.ID, retry.ID)
	}
	if retry.Sequence != acked.Sequence {
		t.Fatalf("lost-ACK retry: want sequence %d, got %d", acked.Sequence, retry.Sequence)
	}
	if countMessages(t, s, chatID) != 1 {
		t.Fatalf("after lost-ACK retry: want 1 row, got %d", countMessages(t, s, chatID))
	}
}

// TestSendMessageEqualTextDifferentClientIDs ensures uniqueness is by clientId,
// not ciphertext: two identical texts with different clientIds create two rows.
func TestSendMessageEqualTextDifferentClientIDs(t *testing.T) {
	s := newStore(t)
	a := registerBootstrap(t, s, "alice")
	b := registerInvited(t, s, a.ID, "bob")
	chatID, err := s.CreateDirectChat(a.ID, b.ID)
	if err != nil {
		t.Fatal(err)
	}

	const sameText = "cipher-same-plaintext"
	m1, created1, err := s.SendMessage(chatID, a.ID, sameText, "iv", "text", nil, "client-A", nil, nil)
	if err != nil || !created1 {
		t.Fatalf("first: err=%v created=%v", err, created1)
	}
	m2, created2, err := s.SendMessage(chatID, a.ID, sameText, "iv", "text", nil, "client-B", nil, nil)
	if err != nil || !created2 {
		t.Fatalf("second: err=%v created=%v", err, created2)
	}
	if m1.ID == m2.ID {
		t.Fatal("expected distinct message ids for different clientIds")
	}
	if countMessages(t, s, chatID) != 2 {
		t.Fatalf("want 2 rows for different clientIds, got %d", countMessages(t, s, chatID))
	}
}

// TestSendMessageClientIDScopedByChatAndSender verifies the unique key is
// (chat_id, sender_id, client_id) so the same clientId in another chat or from
// another sender does not conflict.
func TestSendMessageClientIDScopedByChatAndSender(t *testing.T) {
	s := newStore(t)
	a := registerBootstrap(t, s, "alice")
	b := registerInvited(t, s, a.ID, "bob")
	c := registerInvited(t, s, a.ID, "carol")

	chatAB, err := s.CreateDirectChat(a.ID, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	chatAC, err := s.CreateDirectChat(a.ID, c.ID)
	if err != nil {
		t.Fatal(err)
	}

	const sharedClientID = "shared-client-id"

	msgAB, created, err := s.SendMessage(chatAB, a.ID, "c-ab", "iv", "text", nil, sharedClientID, nil, nil)
	if err != nil || !created {
		t.Fatalf("chat AB alice: err=%v created=%v", err, created)
	}

	// Same sender + clientId in a different chat → new row.
	msgAC, created, err := s.SendMessage(chatAC, a.ID, "c-ac", "iv", "text", nil, sharedClientID, nil, nil)
	if err != nil || !created {
		t.Fatalf("chat AC alice: err=%v created=%v", err, created)
	}
	if msgAB.ID == msgAC.ID {
		t.Fatal("same clientId in different chats must not share message id")
	}

	// Same chat + clientId from a different sender → new row.
	msgBob, created, err := s.SendMessage(chatAB, b.ID, "c-bob", "iv", "text", nil, sharedClientID, nil, nil)
	if err != nil || !created {
		t.Fatalf("chat AB bob: err=%v created=%v", err, created)
	}
	if msgBob.ID == msgAB.ID {
		t.Fatal("same clientId from different sender must not share message id")
	}

	if countMessages(t, s, chatAB) != 2 {
		t.Fatalf("chat AB: want 2 rows (alice+bob), got %d", countMessages(t, s, chatAB))
	}
	if countMessages(t, s, chatAC) != 1 {
		t.Fatalf("chat AC: want 1 row, got %d", countMessages(t, s, chatAC))
	}
}

// TestSendMessageClientIDConcurrentRace hammers the same clientId; the unique
// index must ensure only one logical message row is ever stored.
func TestSendMessageClientIDConcurrentRace(t *testing.T) {
	s := newStore(t)
	a := registerBootstrap(t, s, "alice")
	b := registerInvited(t, s, a.ID, "bob")
	chatID, err := s.CreateDirectChat(a.ID, b.ID)
	if err != nil {
		t.Fatal(err)
	}

	const clientID = "idem-race-client"
	const n = 32

	type result struct {
		id      string
		created bool
		err     error
	}
	results := make([]result, n)
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			msg, created, err := s.SendMessage(chatID, a.ID, fmt.Sprintf("cipher-%d", i), "iv", "text", nil, clientID, nil, nil)
			r := result{created: created, err: err}
			if msg != nil {
				r.id = msg.ID
			}
			results[i] = r
		}(i)
	}
	wg.Wait()

	var createdCount int
	var canonicalID string
	for i, r := range results {
		if r.err != nil {
			t.Fatalf("goroutine %d: %v", i, r.err)
		}
		if r.id == "" {
			t.Fatalf("goroutine %d: empty id", i)
		}
		if canonicalID == "" {
			canonicalID = r.id
		} else if r.id != canonicalID {
			t.Fatalf("goroutine %d: got id %s, want %s", i, r.id, canonicalID)
		}
		if r.created {
			createdCount++
		}
	}
	if createdCount != 1 {
		t.Fatalf("expected exactly one created=true, got %d", createdCount)
	}
	if countMessages(t, s, chatID) != 1 {
		t.Fatalf("want 1 DB row after race, got %d", countMessages(t, s, chatID))
	}
}
