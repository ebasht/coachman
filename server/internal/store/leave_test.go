package store

import (
	"path/filepath"
	"testing"

	"coachman/server/internal/config"
	"coachman/server/internal/db"
)

func TestLeaveDirectChatKeepsPeer(t *testing.T) {
	conn, err := db.Open(config.Config{DBPath: filepath.Join(t.TempDir(), "leave.db")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	s := New(conn, nil)

	alice, err := s.RegisterBootstrapUser("alice", "pubA", "signA")
	if err != nil {
		t.Fatal(err)
	}
	token, err := s.CreateInvite(alice.ID, "bob", 0)
	if err != nil {
		t.Fatal(err)
	}
	bob, err := s.RegisterInvitedUser("pubB", "signB", token)
	if err != nil {
		t.Fatal(err)
	}

	chatID, err := s.CreateDirectChat(alice.ID, bob.ID)
	if err != nil {
		t.Fatal(err)
	}

	if err := s.leaveDirectChat(alice.ID, chatID); err != nil {
		t.Fatal(err)
	}

	ok, err := s.IsMember(chatID, bob.ID)
	if err != nil || !ok {
		t.Fatalf("peer must remain a member after leave, ok=%v err=%v", ok, err)
	}
	ok, err = s.IsMember(chatID, alice.ID)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("leaver must not remain a member")
	}

	// Chat row must still exist for the peer.
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM chats WHERE id = ?`, chatID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("expected chat to remain for peer, count=%d", n)
	}

	// GetChats must not GC the solitary DM (old pruneSolitary did).
	chats, err := s.GetChats(bob.ID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, c := range chats {
		if c.ID == chatID {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("GetChats must still expose solitary DM to remaining member")
	}
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM chats WHERE id = ?`, chatID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("GetChats must not delete solitary DM, count=%d", n)
	}
}
