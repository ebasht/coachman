package store_test

import (
	"testing"

	"coachman/server/internal/store"
)

func TestChatAvatarPermissions(t *testing.T) {
	s := newStore(t)
	admin := registerBootstrap(t, s, "admin")
	alice := registerInvited(t, s, admin.ID, "alice")
	bob := registerInvited(t, s, admin.ID, "bob")

	systemID, err := s.EnsureSystemGroup()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.EnsureAllUsersInSystemGroup(); err != nil {
		t.Fatal(err)
	}

	ok, err := s.CanSetChatAvatar(admin.ID, systemID)
	if err != nil || !ok {
		t.Fatalf("admin should set system avatar: ok=%v err=%v", ok, err)
	}
	ok, err = s.CanSetChatAvatar(alice.ID, systemID)
	if err != nil || ok {
		t.Fatalf("non-admin must not set system avatar: ok=%v err=%v", ok, err)
	}

	jpeg := []byte{
		0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
		0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
	}
	updatedAt, _, err := s.SetChatAvatar(admin.ID, systemID, "image/jpeg", jpeg)
	if err != nil {
		t.Fatal(err)
	}
	if updatedAt <= 0 {
		t.Fatal("expected avatarUpdatedAt")
	}
	data, mime, _, err := s.GetChatAvatar(systemID)
	if err != nil {
		t.Fatal(err)
	}
	if mime != "image/jpeg" || len(data) == 0 {
		t.Fatalf("unexpected avatar mime=%s len=%d", mime, len(data))
	}

	groupID, err := s.CreateGroup(alice.ID, "team", []store.GroupMemberInput{
		{UserID: alice.ID, EncryptedGroupKey: "wrap-alice"},
		{UserID: bob.ID, EncryptedGroupKey: "wrap-bob"},
	})
	if err != nil {
		t.Fatal(err)
	}
	ok, err = s.CanSetChatAvatar(alice.ID, groupID)
	if err != nil || !ok {
		t.Fatalf("creator should set group avatar: ok=%v err=%v", ok, err)
	}
	ok, err = s.CanSetChatAvatar(admin.ID, groupID)
	if err != nil || ok {
		t.Fatalf("admin must not set user-group avatar: ok=%v err=%v", ok, err)
	}
	ok, err = s.CanSetChatAvatar(bob.ID, groupID)
	if err != nil || ok {
		t.Fatalf("non-creator must not set group avatar: ok=%v err=%v", ok, err)
	}

	if _, _, err := s.SetChatAvatar(alice.ID, groupID, "image/jpeg", jpeg); err != nil {
		t.Fatal(err)
	}
	if err := s.ClearChatAvatar(alice.ID, groupID); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := s.GetChatAvatar(groupID); err == nil || err.Error() != "not found" {
		t.Fatalf("expected not found after clear, got %v", err)
	}
}
