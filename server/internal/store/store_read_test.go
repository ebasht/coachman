package store_test

import (
	"testing"
)

func TestSetChatReadAtMonotonic(t *testing.T) {
	s := newStore(t)
	u1 := registerBootstrap(t, s, "alice")
	u2 := registerInvited(t, s, u1.ID, "bob")

	chatID, err := s.CreateDirectChat(u1.ID, u2.ID)
	if err != nil {
		t.Fatal(err)
	}

	if err := s.SetChatReadAt(chatID, u2.ID, 100); err != nil {
		t.Fatal(err)
	}
	if err := s.SetChatReadAt(chatID, u2.ID, 50); err != nil {
		t.Fatal(err)
	}
	at, err := s.GetPeerLastReadAt(chatID, u1.ID)
	if err != nil {
		t.Fatal(err)
	}
	if at != 100 {
		t.Fatalf("expected 100, got %d", at)
	}

	if err := s.SetChatReadAt(chatID, u2.ID, 200); err != nil {
		t.Fatal(err)
	}
	at, err = s.GetPeerLastReadAt(chatID, u1.ID)
	if err != nil {
		t.Fatal(err)
	}
	if at != 200 {
		t.Fatalf("expected 200, got %d", at)
	}
}
