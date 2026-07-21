package store_test

import (
	"path/filepath"
	"testing"

	"coachman/server/internal/blob"
	"coachman/server/internal/config"
	"coachman/server/internal/db"
	"coachman/server/internal/store"
)

// Regression: photo uploads.user_id FK has no ON DELETE CASCADE, so admin
// delete used to fail with "FOREIGN KEY constraint failed" after any photo.
func TestAdminDeleteUserWithUploads(t *testing.T) {
	mem := blob.NewMemory()
	conn, err := db.Open(config.Config{DBPath: filepath.Join(t.TempDir(), "test.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	s := store.New(conn, mem)

	admin := registerBootstrap(t, s, "alice")
	bob := registerInvited(t, s, admin.ID, "bob")
	chatID, err := s.CreateDirectChat(admin.ID, bob.ID)
	if err != nil {
		t.Fatal(err)
	}

	payload := []byte("jpeg")
	imgID, _, err := s.SaveImage(chatID, bob.ID, "plain", "image/jpeg", payload)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = s.SendMessage(chatID, bob.ID, "c", "iv", "image", &imgID, "cid-img", nil)
	if err != nil {
		t.Fatal(err)
	}

	_, err = conn.Exec(`
		INSERT INTO uploads (id, user_id, chat_id, object_key, bucket, content_type, expected_size, status, created_at, expires_at)
		VALUES ('u1', ?, ?, 'chats/x/photo.jpg', 'bucket', 'image/jpeg', 4, 'pending', 1, 9999999999999)
	`, bob.ID, chatID)
	if err != nil {
		t.Fatalf("insert upload: %v", err)
	}

	if err := s.AdminDeleteUser(admin.ID, bob.ID); err != nil {
		t.Fatalf("admin delete bob: %v", err)
	}
	if _, err := s.LoginUser("bob"); err == nil {
		t.Fatal("bob should be gone")
	}
}
