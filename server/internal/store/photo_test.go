package store_test

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"coachman/server/internal/blob"
	"coachman/server/internal/config"
	"coachman/server/internal/db"
	"coachman/server/internal/store"
)

// mockUploader implements blob.Storage + blob.DirectUploader without a real S3.
type mockUploader struct {
	bucket  string
	objects map[string]blob.ObjectStat
}

func newMockUploader() *mockUploader {
	return &mockUploader{bucket: "test-bucket", objects: map[string]blob.ObjectStat{}}
}

// putObject simulates a completed browser PUT.
func (m *mockUploader) putObject(key string, size int64, contentType string) {
	m.objects[key] = blob.ObjectStat{Size: size, ContentType: contentType}
}

func (m *mockUploader) Put(_ context.Context, key string, data []byte) error {
	m.objects[key] = blob.ObjectStat{Size: int64(len(data)), ContentType: "application/octet-stream"}
	return nil
}

func (m *mockUploader) PutWithOptions(_ context.Context, key string, data []byte, opts blob.PutOptions) error {
	m.objects[key] = blob.ObjectStat{Size: int64(len(data)), ContentType: opts.ContentType}
	return nil
}

func (m *mockUploader) Get(_ context.Context, key string) ([]byte, error) {
	if _, ok := m.objects[key]; !ok {
		return nil, errors.New("missing")
	}
	return []byte{}, nil
}

func (m *mockUploader) Delete(_ context.Context, key string) error {
	delete(m.objects, key)
	return nil
}

func (m *mockUploader) MakePublic(_ context.Context, _ string, _ string) error { return nil }

func (m *mockUploader) PresignPut(_ context.Context, key string, _ time.Duration) (string, error) {
	return "https://storage.example/" + key + "?put", nil
}

func (m *mockUploader) PresignPutContentType(_ context.Context, key, contentType string, _ time.Duration) (string, error) {
	return "https://storage.example/" + key + "?ct=" + contentType, nil
}

func (m *mockUploader) PresignGet(_ context.Context, key string, _ time.Duration) (string, error) {
	return "https://storage.example/" + key + "?get", nil
}

func (m *mockUploader) PublicObjectURL(key string) string { return "https://cdn.example/" + key }

func (m *mockUploader) Head(_ context.Context, key string) error {
	if _, ok := m.objects[key]; !ok {
		return errors.New("missing")
	}
	return nil
}

func (m *mockUploader) Stat(_ context.Context, key string) (blob.ObjectStat, error) {
	st, ok := m.objects[key]
	if !ok {
		return blob.ObjectStat{}, errors.New("missing")
	}
	return st, nil
}

func (m *mockUploader) Bucket() string { return m.bucket }

func newPhotoStore(t *testing.T, up blob.Storage) *store.Store {
	t.Helper()
	conn, err := db.Open(config.Config{DBPath: filepath.Join(t.TempDir(), "test.db")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	s := store.New(conn, up)
	s.SetPhotoLimits("", 10<<20, 10*time.Minute, 10*time.Minute)
	return s
}

func photoChat(t *testing.T, s *store.Store) (aID, bID, chatID string) {
	t.Helper()
	a := registerBootstrap(t, s, "alice")
	b := registerInvited(t, s, a.ID, "bob")
	chatID, err := s.CreateDirectChat(a.ID, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	return a.ID, b.ID, chatID
}

func TestInitPhotoUploadServerGeneratedKey(t *testing.T) {
	up := newMockUploader()
	s := newPhotoStore(t, up)
	aID, _, chatID := photoChat(t, s)

	res, err := s.InitPhotoUpload(aID, chatID, "image/jpeg", 1024, "../../etc/passwd")
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if !strings.HasPrefix(res.ObjectKey, "chats/"+chatID+"/") {
		t.Fatalf("object key not server-scoped to chat: %q", res.ObjectKey)
	}
	if strings.Contains(res.ObjectKey, "passwd") || strings.Contains(res.ObjectKey, "..") {
		t.Fatalf("client file name leaked into key: %q", res.ObjectKey)
	}
	if !strings.HasSuffix(res.ObjectKey, ".jpg") {
		t.Fatalf("expected .jpg extension, got %q", res.ObjectKey)
	}
	if res.UploadURL == "" || res.UploadID == "" {
		t.Fatal("expected upload URL and id")
	}
}

func TestInitPhotoUploadRejectsBadType(t *testing.T) {
	up := newMockUploader()
	s := newPhotoStore(t, up)
	aID, _, chatID := photoChat(t, s)

	if _, err := s.InitPhotoUpload(aID, chatID, "application/pdf", 1024, ""); !errors.Is(err, store.ErrUnsupportedPhotoType) {
		t.Fatalf("expected ErrUnsupportedPhotoType, got %v", err)
	}
}

func TestInitPhotoUploadRejectsTooLarge(t *testing.T) {
	up := newMockUploader()
	s := newPhotoStore(t, up)
	aID, _, chatID := photoChat(t, s)

	if _, err := s.InitPhotoUpload(aID, chatID, "image/jpeg", 20<<20, ""); !errors.Is(err, store.ErrPhotoTooLarge) {
		t.Fatalf("expected ErrPhotoTooLarge, got %v", err)
	}
}

func TestCompletePhotoUploadHappyPath(t *testing.T) {
	up := newMockUploader()
	s := newPhotoStore(t, up)
	aID, _, chatID := photoChat(t, s)

	res, err := s.InitPhotoUpload(aID, chatID, "image/jpeg", 4096, "")
	if err != nil {
		t.Fatal(err)
	}
	up.putObject(res.ObjectKey, 4096, "image/jpeg")

	att, err := s.CompletePhotoUpload(aID, res.UploadID, 1920, 1080)
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if att.Type != "image" || att.Size != 4096 || att.Width != 1920 || att.Height != 1080 {
		t.Fatalf("unexpected attachment: %+v", att)
	}
	if att.URL == "" {
		t.Fatal("expected a download URL")
	}
}

func TestCompletePhotoUploadMissingObject(t *testing.T) {
	up := newMockUploader()
	s := newPhotoStore(t, up)
	aID, _, chatID := photoChat(t, s)

	res, err := s.InitPhotoUpload(aID, chatID, "image/jpeg", 4096, "")
	if err != nil {
		t.Fatal(err)
	}
	// Object was never PUT — HeadObject fails.
	if _, err := s.CompletePhotoUpload(aID, res.UploadID, 0, 0); !errors.Is(err, store.ErrUploadObjectMissing) {
		t.Fatalf("expected ErrUploadObjectMissing, got %v", err)
	}
}

func TestCompletePhotoUploadForeignUser(t *testing.T) {
	up := newMockUploader()
	s := newPhotoStore(t, up)
	aID, bID, chatID := photoChat(t, s)

	res, err := s.InitPhotoUpload(aID, chatID, "image/jpeg", 4096, "")
	if err != nil {
		t.Fatal(err)
	}
	up.putObject(res.ObjectKey, 4096, "image/jpeg")

	if _, err := s.CompletePhotoUpload(bID, res.UploadID, 0, 0); !errors.Is(err, store.ErrUploadForbidden) {
		t.Fatalf("expected ErrUploadForbidden, got %v", err)
	}
}

func TestCompletePhotoUploadIdempotent(t *testing.T) {
	up := newMockUploader()
	s := newPhotoStore(t, up)
	aID, _, chatID := photoChat(t, s)

	res, err := s.InitPhotoUpload(aID, chatID, "image/jpeg", 4096, "")
	if err != nil {
		t.Fatal(err)
	}
	up.putObject(res.ObjectKey, 4096, "image/jpeg")

	first, err := s.CompletePhotoUpload(aID, res.UploadID, 100, 200)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.CompletePhotoUpload(aID, res.UploadID, 100, 200)
	if err != nil {
		t.Fatalf("second complete: %v", err)
	}
	if first.ID != second.ID {
		t.Fatalf("expected idempotent attachment id, got %s vs %s", first.ID, second.ID)
	}
}

func TestCompletePhotoUploadExpired(t *testing.T) {
	up := newMockUploader()
	s := newPhotoStore(t, up)
	s.SetPhotoLimits("", 10<<20, time.Nanosecond, 10*time.Minute)
	aID, _, chatID := photoChat(t, s)

	res, err := s.InitPhotoUpload(aID, chatID, "image/jpeg", 4096, "")
	if err != nil {
		t.Fatal(err)
	}
	up.putObject(res.ObjectKey, 4096, "image/jpeg")
	time.Sleep(2 * time.Millisecond)

	if _, err := s.CompletePhotoUpload(aID, res.UploadID, 0, 0); !errors.Is(err, store.ErrUploadExpired) {
		t.Fatalf("expected ErrUploadExpired, got %v", err)
	}
}

func TestGetAttachmentURLAccessControl(t *testing.T) {
	up := newMockUploader()
	s := newPhotoStore(t, up)
	aID, _, chatID := photoChat(t, s)
	carol := registerInvited(t, s, aID, "carol")

	res, err := s.InitPhotoUpload(aID, chatID, "image/jpeg", 4096, "")
	if err != nil {
		t.Fatal(err)
	}
	up.putObject(res.ObjectKey, 4096, "image/jpeg")
	att, err := s.CompletePhotoUpload(aID, res.UploadID, 0, 0)
	if err != nil {
		t.Fatal(err)
	}

	url, _, err := s.GetAttachmentURL(aID, att.ID)
	if err != nil || url == "" {
		t.Fatalf("member should get URL: url=%q err=%v", url, err)
	}
	if _, _, err := s.GetAttachmentURL(carol.ID, att.ID); !errors.Is(err, store.ErrUploadForbidden) {
		t.Fatalf("expected ErrUploadForbidden for non-member, got %v", err)
	}
}

func TestCleanupExpiredUploads(t *testing.T) {
	up := newMockUploader()
	s := newPhotoStore(t, up)
	s.SetPhotoLimits("", 10<<20, time.Nanosecond, 10*time.Minute)
	aID, _, chatID := photoChat(t, s)

	res, err := s.InitPhotoUpload(aID, chatID, "image/jpeg", 4096, "")
	if err != nil {
		t.Fatal(err)
	}
	up.putObject(res.ObjectKey, 4096, "image/jpeg")
	time.Sleep(2 * time.Millisecond)

	n, err := s.CleanupExpiredUploads(time.Now().UnixMilli())
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("expected 1 cleaned upload, got %d", n)
	}
	if _, ok := up.objects[res.ObjectKey]; ok {
		t.Fatal("expected orphaned object to be deleted")
	}
}
