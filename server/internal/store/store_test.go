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
	token, err := s.CreateInvite(inviterID, username, 0)
	if err != nil {
		t.Fatal(err)
	}
	u, err := s.RegisterInvitedUser("key"+username, "sign"+username, token)
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

	token, err := s.CreateInvite(user.ID, "other", 0)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.RegisterInvitedUser("other", "otherSign", token)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.RegisterInvitedUser("x", "y", token)
	if err == nil || err.Error() != "invite already used" {
		t.Fatalf("expected invite already used, got %v", err)
	}

	logged, err := s.LoginUser("testuser")
	if err != nil {
		t.Fatal(err)
	}
	if logged.ID != user.ID {
		t.Fatalf("id mismatch: %s vs %s", logged.ID, user.ID)
	}
}

func TestRebindAdminKeys(t *testing.T) {
	s := newStore(t)
	admin, err := s.RegisterBootstrapUser("admin", "old-pub", "old-sign")
	if err != nil {
		t.Fatal(err)
	}

	rebound, err := s.RebindAdminKeys("new-pub", "new-sign")
	if err != nil {
		t.Fatal(err)
	}
	if rebound.ID != admin.ID {
		t.Fatalf("expected same admin id, got %s vs %s", rebound.ID, admin.ID)
	}
	if rebound.PublicKey != "new-pub" {
		t.Fatalf("expected new public key, got %s", rebound.PublicKey)
	}

	got, err := s.GetUser(admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.PublicKey != "new-pub" {
		t.Fatalf("store public key not updated: %s", got.PublicKey)
	}
	sign, err := s.GetUserSigningPublicKey("admin")
	if err != nil {
		t.Fatal(err)
	}
	if sign != "new-sign" {
		t.Fatalf("signing key not updated: %s", sign)
	}
}

func TestCreateInviteAdminOnly(t *testing.T) {
	s := newStore(t)
	admin := registerBootstrap(t, s, "alice")
	bob := registerInvited(t, s, admin.ID, "bob")

	_, err := s.CreateInvite(bob.ID, "carol", 0)
	if err == nil || err.Error() != "forbidden" {
		t.Fatalf("expected forbidden, got %v", err)
	}
}

func TestNormalizeUsernameAllowsFullName(t *testing.T) {
	got := store.NormalizeUsername("  Иван   Петров  ")
	if got != "Иван Петров" {
		t.Fatalf("got %q", got)
	}
	if store.NormalizeUsername("   ") != "" {
		t.Fatal("expected empty")
	}
}

func TestCreateInviteFullName(t *testing.T) {
	s := newStore(t)
	admin := registerBootstrap(t, s, "alice")

	token, err := s.CreateInvite(admin.ID, "Иван Петров", 0)
	if err != nil {
		t.Fatal(err)
	}
	u, err := s.RegisterInvitedUser("keyivan", "signivan", token)
	if err != nil {
		t.Fatal(err)
	}
	if u.Username != "Иван Петров" {
		t.Fatalf("expected Иван Петров, got %q", u.Username)
	}
	// Same reserved name must not get a second invite while the user exists.
	// (SQLite lower() is ASCII-only, so Cyrillic case-folding is not asserted here.)
	_, err = s.CreateInvite(admin.ID, "Иван Петров", 0)
	if err == nil || err.Error() != "username taken" {
		t.Fatalf("expected username taken, got %v", err)
	}
}

func TestCreateInviteReservedUsername(t *testing.T) {
	s := newStore(t)
	admin := registerBootstrap(t, s, "alice")

	token, err := s.CreateInvite(admin.ID, "bob", 0)
	if err != nil {
		t.Fatal(err)
	}
	// Re-issuing replaces the unused invite (old token becomes invalid).
	token2, err := s.CreateInvite(admin.ID, "bob", 0)
	if err != nil {
		t.Fatalf("expected re-issue, got %v", err)
	}
	if token2 == token {
		t.Fatal("expected a new invite token")
	}
	if _, err := s.RegisterInvitedUser("keyold", "signold", token); err == nil {
		t.Fatal("old invite token should be invalid after re-issue")
	}

	bob, err := s.RegisterInvitedUser("keybob", "signbob", token2)
	if err != nil {
		t.Fatal(err)
	}

	_, err = s.CreateInvite(admin.ID, "bob", 0)
	if err == nil || err.Error() != "username taken" {
		t.Fatalf("expected username taken, got %v", err)
	}

	if err := s.DeleteUser(bob.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateInvite(admin.ID, "bob", 0); err != nil {
		t.Fatalf("expected invite after delete, got %v", err)
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

func TestDeleteGroupCreator(t *testing.T) {
	s := newStore(t)
	a := registerBootstrap(t, s, "alice")
	b := registerInvited(t, s, a.ID, "bob")

	_, err := s.CreateGroup(a.ID, "team", []store.GroupMemberInput{
		{UserID: a.ID, EncryptedGroupKey: "encA"},
		{UserID: b.ID, EncryptedGroupKey: "encB"},
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := s.DeleteUser(a.ID); err != nil {
		t.Fatalf("delete group creator: %v", err)
	}
	if _, err := s.LoginUser("alice"); err == nil {
		t.Fatal("alice should be deleted")
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

func TestDeleteDirectChat(t *testing.T) {
	s := newStore(t)
	admin := registerBootstrap(t, s, "alice")
	bob := registerInvited(t, s, admin.ID, "bob")
	chatID, err := s.CreateDirectChat(admin.ID, bob.ID)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := s.DeleteChat(chatID, admin.ID); err != nil {
		t.Fatalf("delete direct chat: %v", err)
	}
	member, _ := s.IsMember(chatID, admin.ID)
	if member {
		t.Fatal("direct chat should be deleted")
	}
	adminChats, err := s.GetChats(admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range adminChats {
		if c.ID == chatID {
			t.Fatal("deleted direct chat should not reappear as the same id")
		}
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
	var direct *store.Chat
	var system *store.Chat
	for i := range chats {
		if chats[i].IsSystem {
			system = &chats[i]
		} else if chats[i].Type == "direct" {
			direct = &chats[i]
		}
	}
	if system == nil {
		t.Fatal("expected system group for bob")
	}
	if direct == nil {
		t.Fatal("expected support DM with admin even in a 2-person circle")
	}
	peerAdmin := false
	for _, m := range direct.Members {
		if m.ID == admin.ID && m.IsAdmin {
			peerAdmin = true
		}
	}
	if !peerAdmin {
		t.Fatal("direct chat should be with admin")
	}

	adminChats, err := s.GetChats(admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	adminDirect := 0
	adminSystem := 0
	for _, c := range adminChats {
		if c.IsSystem {
			adminSystem++
		} else if c.Type == "direct" {
			adminDirect++
		}
	}
	if adminSystem != 1 {
		t.Fatalf("expected 1 system group for admin, got %d", adminSystem)
	}
	if adminDirect != 1 {
		t.Fatalf("expected 1 support DM for admin in a 2-person circle, got %d", adminDirect)
	}

	carol := registerInvited(t, s, admin.ID, "carol")
	_ = carol
	chats3, err := s.GetChats(admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	adminDirect = 0
	for _, c := range chats3 {
		if c.Type == "direct" {
			adminDirect++
		}
	}
	if adminDirect < 2 {
		t.Fatalf("expected direct chats after 3rd user, got %d", adminDirect)
	}
}

func TestSystemGroup(t *testing.T) {
	s := newStore(t)
	admin := registerBootstrap(t, s, "alice")
	bob := registerInvited(t, s, admin.ID, "bob")

	id, err := s.EnsureSystemGroup()
	if err != nil {
		t.Fatal(err)
	}
	id2, err := s.EnsureSystemGroup()
	if err != nil {
		t.Fatal(err)
	}
	if id != id2 {
		t.Fatalf("expected same system group id, got %s and %s", id, id2)
	}

	if err := s.EnsureAllUsersInSystemGroup(); err != nil {
		t.Fatal(err)
	}
	ok, _ := s.IsMember(id, admin.ID)
	if !ok {
		t.Fatal("admin should be in system group")
	}
	ok, _ = s.IsMember(id, bob.ID)
	if !ok {
		t.Fatal("bob should be in system group")
	}

	if _, err := s.DeleteChat(id, admin.ID); err == nil || err.Error() != "system chat" {
		t.Fatalf("expected system chat delete error, got %v", err)
	}
	if err := s.RemoveGroupMember(id, admin.ID, bob.ID); err == nil || err.Error() != "system chat" {
		t.Fatalf("expected system chat remove error, got %v", err)
	}

	wraps := []store.GroupMemberInput{
		{UserID: admin.ID, EncryptedGroupKey: "wrap-admin"},
		{UserID: bob.ID, EncryptedGroupKey: "wrap-bob"},
	}
	if err := s.DistributeSystemGroupKeys(admin.ID, wraps); err != nil {
		t.Fatal(err)
	}
	chats, err := s.GetChats(admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	var systemChat *store.Chat
	for i := range chats {
		if chats[i].IsSystem {
			systemChat = &chats[i]
			break
		}
	}
	if systemChat == nil {
		t.Fatal("expected system group")
	}
	for _, m := range systemChat.Members {
		if m.EncryptedGroupKey == nil || *m.EncryptedGroupKey == "" {
			t.Fatalf("expected key for %s", m.Username)
		}
	}
	// Second distribute must not overwrite.
	if err := s.DistributeSystemGroupKeys(admin.ID, []store.GroupMemberInput{
		{UserID: bob.ID, EncryptedGroupKey: "wrap-bob-2"},
	}); err != nil {
		t.Fatal(err)
	}
	chats, _ = s.GetChats(admin.ID)
	for _, c := range chats {
		if !c.IsSystem {
			continue
		}
		for _, m := range c.Members {
			if m.ID == bob.ID && m.EncryptedGroupKey != nil && *m.EncryptedGroupKey != "wrap-bob" {
				t.Fatalf("expected original wrap, got %s", *m.EncryptedGroupKey)
			}
		}
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

func TestAdminUsers(t *testing.T) {
	s := newStore(t)
	admin := registerBootstrap(t, s, "alice")
	bob := registerInvited(t, s, admin.ID, "bob")

	users, err := s.ListUsersAdmin(admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(users) != 2 {
		t.Fatalf("expected 2 users, got %d", len(users))
	}

	_, err = s.ListUsersAdmin(bob.ID)
	if err == nil || err.Error() != "forbidden" {
		t.Fatalf("expected forbidden for non-admin, got %v", err)
	}

	if err := s.AdminDeleteUser(admin.ID, admin.ID); err == nil || err.Error() != "cannot delete self" {
		t.Fatalf("expected cannot delete self, got %v", err)
	}
	if err := s.AdminDeleteUser(bob.ID, admin.ID); err == nil || err.Error() != "forbidden" {
		t.Fatalf("expected forbidden for non-admin delete, got %v", err)
	}
	if err := s.AdminDeleteUser(admin.ID, bob.ID); err != nil {
		t.Fatalf("delete bob: %v", err)
	}
	if _, err := s.LoginUser("bob"); err == nil {
		t.Fatal("bob should be deleted")
	}
}
