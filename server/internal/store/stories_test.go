package store_test

import (
	"path/filepath"
	"testing"
	"time"

	"coachman/server/internal/config"
	"coachman/server/internal/db"
	"coachman/server/internal/store"
)

func TestStoriesFeedAndExpiry(t *testing.T) {
	conn, err := db.Open(config.Config{DBPath: filepath.Join(t.TempDir(), "stories.db")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	blobs := newMockUploader()
	s := store.New(conn, blobs)
	s.SetPhotoLimits("", 10<<20, time.Minute, 15*time.Minute)

	admin := registerBootstrap(t, s, "admin")
	bob := registerInvited(t, s, admin.ID, "bob")

	jpeg := []byte{0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01, 0x02, 0x03} // minimal-ish jpeg magic
	item, err := s.CreateStory(bob.ID, "image/jpeg", jpeg, 100, 200)
	if err != nil {
		t.Fatal(err)
	}
	if item.ID == "" || item.ExpiresAt <= item.CreatedAt {
		t.Fatalf("bad story %+v", item)
	}

	feed, err := s.ListStoryFeed(admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(feed) < 2 {
		t.Fatalf("expected me + bob, got %d", len(feed))
	}
	if !feed[0].IsMe {
		t.Fatal("first author should be me")
	}
	var bobAuthor *store.StoryAuthor
	for i := range feed {
		if feed[i].UserID == bob.ID {
			bobAuthor = &feed[i]
			break
		}
	}
	if bobAuthor == nil || len(bobAuthor.Stories) != 1 {
		t.Fatalf("bob stories missing: %+v", feed)
	}
	if !bobAuthor.HasUnseen {
		t.Fatal("expected unseen")
	}

	if err := s.MarkStoryViewed(admin.ID, item.ID); err != nil {
		t.Fatal(err)
	}
	feed, err = s.ListStoryFeed(admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range feed {
		if a.UserID == bob.ID && a.HasUnseen {
			t.Fatal("expected seen after view")
		}
	}

	n, err := s.CleanupExpiredStories(item.ExpiresAt + 1)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("expected 1 cleaned, got %d", n)
	}
}
