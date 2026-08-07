package store_test

import (
	"errors"
	"strings"
	"testing"

	"coachman/server/internal/store"
)

func TestInitVideoUploadAcceptsMp4(t *testing.T) {
	up := newMockUploader()
	s := newPhotoStore(t, up)
	aID, _, chatID := photoChat(t, s)

	res, err := s.InitVideoUpload(aID, chatID, "video/mp4", 1024*1024, "clip.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if res.UploadID == "" || res.UploadURL == "" {
		t.Fatalf("empty upload: %+v", res)
	}
	if !strings.HasSuffix(res.ObjectKey, ".mp4") {
		t.Fatalf("expected .mp4 key, got %s", res.ObjectKey)
	}
	if strings.Contains(res.ObjectKey, "clip") {
		t.Fatalf("client file name leaked into key: %q", res.ObjectKey)
	}
}

func TestInitVideoUploadRejectsBadType(t *testing.T) {
	up := newMockUploader()
	s := newPhotoStore(t, up)
	aID, _, chatID := photoChat(t, s)

	if _, err := s.InitVideoUpload(aID, chatID, "video/avi", 1024, ""); !errors.Is(err, store.ErrUnsupportedVideoType) {
		t.Fatalf("want ErrUnsupportedVideoType, got %v", err)
	}
}

func TestInitVideoUploadRejectsTooLarge(t *testing.T) {
	up := newMockUploader()
	s := newPhotoStore(t, up)
	s.SetVideoMaxSize(10 << 20)
	aID, _, chatID := photoChat(t, s)

	if _, err := s.InitVideoUpload(aID, chatID, "video/mp4", 20<<20, ""); !errors.Is(err, store.ErrVideoTooLarge) {
		t.Fatalf("want ErrVideoTooLarge, got %v", err)
	}
}

func TestCompleteVideoUpload(t *testing.T) {
	up := newMockUploader()
	s := newPhotoStore(t, up)
	aID, _, chatID := photoChat(t, s)

	res, err := s.InitVideoUpload(aID, chatID, "video/mp4", 4096, "")
	if err != nil {
		t.Fatal(err)
	}
	up.putObject(res.ObjectKey, 4096, "video/mp4")

	att, err := s.CompleteVideoUpload(aID, res.UploadID, 1280, 720)
	if err != nil {
		t.Fatal(err)
	}
	if att.Type != "video" || att.MimeType != "video/mp4" || att.Size != 4096 {
		t.Fatalf("unexpected attachment: %+v", att)
	}
	if att.Width != 1280 || att.Height != 720 {
		t.Fatalf("unexpected dims: %+v", att)
	}
}
