package store_test

import (
	"path/filepath"
	"testing"

	"coachman/server/internal/config"
	"coachman/server/internal/db"
	"coachman/server/internal/store"
	"coachman/server/internal/blob"
)

func newStore(t *testing.T) *store.Store {
	t.Helper()
	conn, err := db.Open(config.Config{DBPath: filepath.Join(t.TempDir(), "test.db")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return store.New(conn, nil)
}

func registerBootstrap(t *testing.T, s *store.Store, username string) *store.User {
	t.Helper()
	u, err := s.RegisterBootstrapUser(username, "key"+username, "sign"+username)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func registerInvited(t *testing.T, s *store.Store, inviterID, username string) *store.User {
	t.Helper()
	token, err := s.CreateInvite(inviterID, 0)
	if err != nil {
		t.Fatal(err)
	}
	u, err := s.RegisterInvitedUser(username, "key"+username, "sign"+username, token)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func TestRegisterAndLogin(t *testing.T) {
	s := newStore(t)

	user, err := s.RegisterBootstrapUser("testuser", "pubkey123", "signkey123")
	if err != nil {
		t.Fatal(err)
	}
	if user.Username != "testuser" {
		t.Fatalf("expected testuser, got %s", user.Username)
	}
	if !user.IsAdmin {
		t.Fatal("expected admin")
	}

	token, err := s.CreateInvite(user.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.RegisterInvitedUser("other", "other", "otherSign", token)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.RegisterInvitedUser("testuser", "x", "y", token)
	if err == nil {
		t.Fatal("expected username taken error")
	}

	logged, err := s.LoginUser("testuser")
	if err != nil {
		t.Fatal(err)
	}
	if logged.ID != user.ID {
		t.Fatalf("id mismatch: %s vs %s", logged.ID, user.ID)
	}
}

func TestDirectChat(t *testing.T) {
	s := newStore(t)
	a := registerBootstrap(t, s, "alice")
	b := registerInvited(t, s, a.ID, "bob")

	id1, err := s.CreateDirectChat(a.ID, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	id2, err := s.CreateDirectChat(a.ID, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	if id1 != id2 {
		t.Fatalf("expected same chat id, got %s and %s", id1, id2)
	}
}

func TestDeleteUserWithData(t *testing.T) {
	s := newStore(t)
	a := registerBootstrap(t, s, "alice")
	b := registerInvited(t, s, a.ID, "bob")
	chatID, _ := s.CreateDirectChat(a.ID, b.ID)

	_, err := s.SendMessage(chatID, a.ID, "cipher", "iv", "text", nil)
	if err != nil {
		t.Fatal(err)
	}

	if err := s.DeleteUser(a.ID); err != nil {
		t.Fatalf("delete alice: %v", err)
	}

	if _, err := s.LoginUser("alice"); err == nil {
		t.Fatal("user still exists")
	}
}


func TestAddRemoveGroupMember(t *testing.T) {
	s := newStore(t)
	a := registerBootstrap(t, s, "alice")
	b := registerInvited(t, s, a.ID, "bob")
	c := registerInvited(t, s, a.ID, "carol")

	chatID, err := s.CreateGroup(a.ID, "team", []store.GroupMemberInput{
		{UserID: a.ID, EncryptedGroupKey: "encA"},
		{UserID: b.ID, EncryptedGroupKey: "encB"},
	})
	if err != nil {
		t.Fatal(err)
	}

	creator, err := s.GetGroupCreator(chatID)
	if err != nil || creator != a.ID {
		t.Fatalf("expected creator alice, got %q err=%v", creator, err)
	}

	if err := s.AddGroupMember(chatID, b.ID, c.ID, "encC"); err == nil {
		t.Fatal("non-creator should not add members")
	}
	if err := s.AddGroupMember(chatID, a.ID, c.ID, "encC"); err != nil {
		t.Fatal(err)
	}
	member, _ := s.IsMember(chatID, c.ID)
	if !member {
		t.Fatal("carol should be member")
	}

	if err := s.RemoveGroupMember(chatID, b.ID, c.ID); err == nil {
		t.Fatal("non-creator should not remove members")
	}
	if err := s.RemoveGroupMember(chatID, a.ID, c.ID); err != nil {
		t.Fatal(err)
	}
	member, _ = s.IsMember(chatID, c.ID)
	if member {
		t.Fatal("carol should not be member")
	}

	if err := s.AddGroupMemberWithRekey(chatID, a.ID, c.ID, "encC2", 2, []store.GroupMemberInput{
		{UserID: a.ID, EncryptedGroupKey: "encA2"},
		{UserID: b.ID, EncryptedGroupKey: "encB2"},
	}); err != nil {
		t.Fatal(err)
	}
	epoch, err := s.GetGroupKeyEpoch(chatID)
	if err != nil || epoch != 2 {
		t.Fatalf("expected epoch 2, got %d err=%v", epoch, err)
	}

	if err := s.RemoveGroupMember(chatID, a.ID, a.ID); err == nil {
		t.Fatal("creator cannot remove self via remove member")
	}
	if err := s.RemoveGroupMember(chatID, a.ID, c.ID); err != nil {
		t.Fatal(err)
	}

	if _, err := s.DeleteGroup(chatID, b.ID); err == nil {
		t.Fatal("non-creator should not delete group")
	}
	memberIDs, err := s.DeleteGroup(chatID, a.ID)
	if err != nil {
		t.Fatalf("delete group: %v", err)
	}
	if len(memberIDs) != 2 {
		t.Fatalf("expected 2 members notified, got %d", len(memberIDs))
	}
	member, _ = s.IsMember(chatID, a.ID)
	if member {
		t.Fatal("group should be deleted")
	}
}

func TestCircleDirectChats(t *testing.T) {
	s := newStore(t)
	admin := registerBootstrap(t, s, "alice")
	bob := registerInvited(t, s, admin.ID, "bob")

	chats, err := s.GetChats(bob.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(chats) != 1 {
		t.Fatalf("expected 1 direct chat for bob, got %d", len(chats))
	}
	if chats[0].DisplayName != "alice" {
		t.Fatalf("expected chat with alice, got %s", chats[0].DisplayName)
	}

	adminChats, err := s.GetChats(admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(adminChats) != 1 {
		t.Fatalf("expected 1 direct chat for admin, got %d", len(adminChats))
	}
}

func TestDeleteAccountByUsernameCaseInsensitive(t *testing.T) {
	s := newStore(t)
	registerBootstrap(t, s, "MyUser")

	if err := s.DeleteAccountByUsername("myuser"); err != nil {
		t.Fatal(err)
	}
	if s.IsUsernameTaken("MyUser") {
		t.Fatal("expected username to be free after delete")
	}
}

func TestSaveImageWithBlobStorage(t *testing.T) {
	mem := blob.NewMemory()
	conn, err := db.Open(config.Config{DBPath: filepath.Join(t.TempDir(), "test.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	s := store.New(conn, mem)
	a := registerBootstrap(t, s, "alice")
	b := registerInvited(t, s, a.ID, "bob")
	chatID, _ := s.CreateDirectChat(a.ID, b.ID)

	payload := []byte("encrypted-image-bytes")
	id, _, err := s.SaveImage(chatID, a.ID, "iv123", "image/jpeg", payload)
	if err != nil {
		t.Fatal(err)
	}

	img, err := s.GetImage(id)
	if err != nil {
		t.Fatal(err)
	}
	if string(img.Ciphertext) != string(payload) {
		t.Fatalf("expected payload from blob storage, got %q", img.Ciphertext)
	}
}
