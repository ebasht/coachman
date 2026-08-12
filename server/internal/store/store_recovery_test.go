package store_test

import "testing"

func TestLoginRecoveryRoundTrip(t *testing.T) {
	s := newStore(t)
	admin := registerBootstrap(t, s, "admin")
	bob := registerInvited(t, s, admin.ID, "bob")

	if _, err := s.GetUserKeyBackup(admin.ID, bob.ID); err == nil || err.Error() != "backup not found" {
		t.Fatalf("expected backup not found, got %v", err)
	}

	if err := s.UpsertUserKeyBackup(bob.ID, `{"v":2,"epk":"x","ct":"y","iv":"z"}`); err != nil {
		t.Fatal(err)
	}
	ct, err := s.GetUserKeyBackup(admin.ID, bob.ID)
	if err != nil || ct == "" {
		t.Fatalf("get backup: %v %q", err, ct)
	}
	has, err := s.HasUserKeyBackup(bob.ID)
	if err != nil || !has {
		t.Fatalf("has backup: %v %v", err, has)
	}

	users, err := s.ListUsersAdmin(admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	var foundBackup bool
	for _, u := range users {
		if u.ID == bob.ID {
			foundBackup = u.HasKeyBackup
		}
	}
	if !foundBackup {
		t.Fatal("admin list missing backup flag for bob")
	}

	session, err := s.CreateLoginRecovery(admin.ID, bob.ID, `{"v":1,"ciphertext":"c","iv":"i"}`)
	if err != nil {
		t.Fatal(err)
	}
	if session.Token == "" || session.Username != "bob" {
		t.Fatalf("session: %+v", session)
	}

	peek, err := s.PeekLoginRecovery(session.Token)
	if err != nil || peek.Username != "bob" {
		t.Fatalf("peek: %v %+v", err, peek)
	}

	tvBefore, err := s.GetTokenVersion(bob.ID)
	if err != nil {
		t.Fatal(err)
	}

	consumed, err := s.ConsumeLoginRecovery(session.Token)
	if err != nil {
		t.Fatal(err)
	}
	if consumed.Ciphertext == "" || consumed.PublicKey != "keybob" {
		t.Fatalf("consumed: %+v", consumed)
	}

	tvAfter, err := s.GetTokenVersion(bob.ID)
	if err != nil {
		t.Fatal(err)
	}
	if tvAfter != tvBefore {
		t.Fatalf("token version must stay stable for multi-device: before=%d after=%d", tvBefore, tvAfter)
	}

	// Same QR may authorize another device until TTL.
	again, err := s.ConsumeLoginRecovery(session.Token)
	if err != nil {
		t.Fatalf("second consume: %v", err)
	}
	if again.Ciphertext != consumed.Ciphertext {
		t.Fatalf("second consume ciphertext mismatch")
	}
	if _, err := s.PeekLoginRecovery(session.Token); err != nil {
		t.Fatalf("peek after use: %v", err)
	}
}

func TestLoginRecoveryNewQRRevokesOld(t *testing.T) {
	s := newStore(t)
	admin := registerBootstrap(t, s, "admin")
	bob := registerInvited(t, s, admin.ID, "bob")

	first, err := s.CreateLoginRecovery(admin.ID, bob.ID, `cipher-1`)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.CreateLoginRecovery(admin.ID, bob.ID, `cipher-2`)
	if err != nil {
		t.Fatal(err)
	}
	if first.Token == second.Token {
		t.Fatal("expected distinct tokens")
	}
	if _, err := s.ConsumeLoginRecovery(first.Token); err == nil || err.Error() != "invalid recovery" {
		t.Fatalf("old QR should be revoked, got %v", err)
	}
	got, err := s.ConsumeLoginRecovery(second.Token)
	if err != nil || got.Ciphertext != "cipher-2" {
		t.Fatalf("new QR: %v %+v", err, got)
	}
}

func TestLoginRecoveryForbidden(t *testing.T) {
	s := newStore(t)
	admin := registerBootstrap(t, s, "admin")
	bob := registerInvited(t, s, admin.ID, "bob")
	_ = s.UpsertUserKeyBackup(bob.ID, "cipher")

	if _, err := s.GetUserKeyBackup(bob.ID, bob.ID); err == nil || err.Error() != "forbidden" {
		t.Fatalf("non-admin get backup: %v", err)
	}
	if _, err := s.CreateLoginRecovery(bob.ID, admin.ID, "cipher"); err == nil || err.Error() != "forbidden" {
		t.Fatalf("non-admin create recovery: %v", err)
	}
}

func TestGetAdminPublicKey(t *testing.T) {
	s := newStore(t)
	if _, err := s.GetAdminPublicKey(); err == nil {
		t.Fatal("expected admin not found")
	}
	registerBootstrap(t, s, "admin")
	pub, err := s.GetAdminPublicKey()
	if err != nil || pub != "keyadmin" {
		t.Fatalf("got %q %v", pub, err)
	}
}
