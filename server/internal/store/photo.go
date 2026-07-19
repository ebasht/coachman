package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"coachman/server/internal/blob"
)

// Photo direct-upload errors. Handlers map these to HTTP status codes; the raw
// technical cause (S3 errors, presigned URLs) is never surfaced to the client.
var (
	ErrDirectUploadUnavailable = errors.New("direct upload unavailable")
	ErrUnsupportedPhotoType    = errors.New("unsupported image type")
	ErrPhotoTooLarge           = errors.New("photo too large")
	ErrUploadNotFound          = errors.New("upload not found")
	ErrUploadForbidden         = errors.New("upload forbidden")
	ErrUploadNotPending        = errors.New("upload not pending")
	ErrUploadExpired           = errors.New("upload expired")
	ErrUploadObjectMissing     = errors.New("uploaded object missing")
	ErrUploadSizeMismatch      = errors.New("uploaded size mismatch")
)

// photoContentTypes is the server-side whitelist mapping MIME → file extension.
// AVIF is accepted for storage; the browser declares it only when it can encode it.
var photoContentTypes = map[string]string{
	"image/jpeg": "jpg",
	"image/png":  "png",
	"image/webp": "webp",
	"image/avif": "avif",
}

func photoExtension(contentType string) (string, bool) {
	ext, ok := photoContentTypes[contentType]
	return ext, ok
}

func (s *Store) photoMaxBytes() int64 {
	if s.photoMaxSize > 0 {
		return s.photoMaxSize
	}
	return 30 << 20
}

func (s *Store) uploader() (blob.DirectUploader, bool) {
	du, ok := s.blobs.(blob.DirectUploader)
	return du, ok
}

// PhotoUpload is the result of InitPhotoUpload: a presigned PUT target for the browser.
type PhotoUpload struct {
	UploadID  string
	UploadURL string
	ObjectKey string
	ExpiresAt int64 // unix millis
}

// Attachment is the confirmed image record returned by CompletePhotoUpload.
type Attachment struct {
	ID        string
	Type      string
	MimeType  string
	Size      int64
	Width     int
	Height    int
	ObjectKey string
	URL       string
}

// InitPhotoUpload validates the declared metadata, generates a server-owned object
// key, records a pending upload row, and returns a short-lived presigned PUT URL.
// The client never supplies the object key.
func (s *Store) InitPhotoUpload(userID, chatID, contentType string, size int64, fileName string) (*PhotoUpload, error) {
	du, ok := s.uploader()
	if !ok {
		return nil, ErrDirectUploadUnavailable
	}
	ext, ok := photoExtension(contentType)
	if !ok {
		return nil, ErrUnsupportedPhotoType
	}
	if size <= 0 || size > s.photoMaxBytes() {
		return nil, ErrPhotoTooLarge
	}

	now := time.Now()
	id := uuid.New().String()
	key := fmt.Sprintf("chats/%s/%04d/%02d/%s.%s", chatID, now.Year(), int(now.Month()), uuid.New().String(), ext)

	ttl := s.photoUploadTTL
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	uploadURL, err := du.PresignPutContentType(ctx, key, contentType, ttl)
	if err != nil {
		return nil, fmt.Errorf("presign put: %w", err)
	}

	createdAt := now.UnixMilli()
	expiresAt := now.Add(ttl).UnixMilli()
	if _, err := s.db.Exec(`
		INSERT INTO uploads (id, user_id, chat_id, object_key, bucket, content_type, expected_size, status, created_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
	`, id, userID, chatID, key, du.Bucket(), contentType, size, createdAt, expiresAt); err != nil {
		return nil, fmt.Errorf("record upload: %w", err)
	}

	return &PhotoUpload{UploadID: id, UploadURL: uploadURL, ObjectKey: key, ExpiresAt: expiresAt}, nil
}

// CompletePhotoUpload verifies the object exists via HeadObject, validates its real
// size and Content-Type, then creates the image attachment. Idempotent: a second
// call for an already-completed upload returns the same attachment.
func (s *Store) CompletePhotoUpload(userID, uploadID string, width, height int) (*Attachment, error) {
	du, ok := s.uploader()
	if !ok {
		return nil, ErrDirectUploadUnavailable
	}

	var (
		ownerID, chatID, objectKey, bucket, contentType, status string
		expectedSize                                            int64
		imageID                                                 sql.NullString
		expiresAt                                               int64
	)
	err := s.db.QueryRow(`
		SELECT user_id, chat_id, object_key, bucket, content_type, expected_size, status, image_id, expires_at
		FROM uploads WHERE id = ?
	`, uploadID).Scan(&ownerID, &chatID, &objectKey, &bucket, &contentType, &expectedSize, &status, &imageID, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUploadNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("load upload: %w", err)
	}
	if ownerID != userID {
		return nil, ErrUploadForbidden
	}

	// Idempotency: already completed → return the existing attachment.
	if status == "completed" && imageID.Valid {
		att, err := s.attachmentByImageID(du, imageID.String)
		if err == nil {
			return att, nil
		}
		// Fall through to rebuild only if the image row vanished.
	}
	if status != "pending" && status != "completed" {
		return nil, ErrUploadNotPending
	}
	if status == "pending" && time.Now().UnixMilli() > expiresAt {
		_, _ = s.db.Exec(`UPDATE uploads SET status = 'failed' WHERE id = ?`, uploadID)
		return nil, ErrUploadExpired
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	stat, err := du.Stat(ctx, objectKey)
	if err != nil {
		_, _ = s.db.Exec(`UPDATE uploads SET status = 'failed' WHERE id = ?`, uploadID)
		return nil, ErrUploadObjectMissing
	}
	if stat.Size <= 0 || stat.Size > s.photoMaxBytes() {
		_, _ = s.db.Exec(`UPDATE uploads SET status = 'failed' WHERE id = ?`, uploadID)
		return nil, ErrPhotoTooLarge
	}
	// Reasonable size check: object must not materially exceed the declared size.
	if expectedSize > 0 && stat.Size > expectedSize+64*1024 {
		_, _ = s.db.Exec(`UPDATE uploads SET status = 'failed' WHERE id = ?`, uploadID)
		return nil, ErrUploadSizeMismatch
	}

	actualType := stat.ContentType
	if actualType == "" {
		actualType = contentType
	}
	if _, ok := photoExtension(actualType); !ok {
		_, _ = s.db.Exec(`UPDATE uploads SET status = 'failed' WHERE id = ?`, uploadID)
		return nil, ErrUnsupportedPhotoType
	}

	newImageID := uuid.New().String()
	createdAt := time.Now().UnixMilli()
	if _, err := s.db.Exec(`
		INSERT INTO images (id, chat_id, uploader_id, ciphertext, iv, mime_type, created_at, storage_key, size_bytes, width, height)
		VALUES (?, ?, ?, ?, 'plain', ?, ?, ?, ?, ?, ?)
	`, newImageID, chatID, userID, []byte{}, actualType, createdAt, objectKey, stat.Size, width, height); err != nil {
		return nil, fmt.Errorf("record image: %w", err)
	}
	if _, err := s.db.Exec(`UPDATE uploads SET status = 'completed', image_id = ? WHERE id = ?`, newImageID, uploadID); err != nil {
		return nil, fmt.Errorf("finalize upload: %w", err)
	}

	url, _ := s.photoDownloadURL(du, objectKey)
	return &Attachment{
		ID:        newImageID,
		Type:      "image",
		MimeType:  actualType,
		Size:      stat.Size,
		Width:     width,
		Height:    height,
		ObjectKey: objectKey,
		URL:       url,
	}, nil
}

func (s *Store) attachmentByImageID(du blob.DirectUploader, imageID string) (*Attachment, error) {
	var (
		chatID, mimeType string
		storageKey       sql.NullString
		size             int64
		width, height    int
	)
	err := s.db.QueryRow(`
		SELECT chat_id, mime_type, storage_key, size_bytes, width, height FROM images WHERE id = ?
	`, imageID).Scan(&chatID, &mimeType, &storageKey, &size, &width, &height)
	if err != nil {
		return nil, err
	}
	url := ""
	if storageKey.Valid {
		url, _ = s.photoDownloadURL(du, storageKey.String)
	}
	return &Attachment{
		ID: imageID, Type: "image", MimeType: mimeType, Size: size,
		Width: width, Height: height, ObjectKey: storageKey.String, URL: url,
	}, nil
}

// photoDownloadURL returns a CDN URL (public model) or a short-lived presigned GET
// URL (private-bucket model, the default). Never persisted as a permanent address.
func (s *Store) photoDownloadURL(du blob.DirectUploader, key string) (string, error) {
	if key == "" {
		return "", nil
	}
	if s.photoCDNBase != "" {
		return s.photoCDNBase + "/" + key, nil
	}
	ttl := s.photoDownloadTTL
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return du.PresignGet(ctx, key, ttl)
}

// GetAttachmentURL returns a short-lived download URL for an image after verifying
// the caller can access the owning chat.
func (s *Store) GetAttachmentURL(userID, imageID string) (url string, expiresAt int64, err error) {
	du, ok := s.uploader()
	if !ok {
		return "", 0, ErrDirectUploadUnavailable
	}
	var (
		chatID     string
		storageKey sql.NullString
	)
	e := s.db.QueryRow(`SELECT chat_id, storage_key FROM images WHERE id = ?`, imageID).Scan(&chatID, &storageKey)
	if errors.Is(e, sql.ErrNoRows) {
		return "", 0, ErrUploadNotFound
	}
	if e != nil {
		return "", 0, e
	}
	member, e := s.IsMember(chatID, userID)
	if e != nil || !member {
		return "", 0, ErrUploadForbidden
	}
	if !storageKey.Valid || storageKey.String == "" {
		return "", 0, ErrUploadObjectMissing
	}
	url, err = s.photoDownloadURL(du, storageKey.String)
	if err != nil {
		return "", 0, err
	}
	ttl := s.photoDownloadTTL
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	return url, time.Now().Add(ttl).UnixMilli(), nil
}

// CleanupExpiredUploads removes pending uploads whose presigned URL has expired,
// best-effort deleting any orphaned object that was PUT but never confirmed.
func (s *Store) CleanupExpiredUploads(now int64) (int, error) {
	rows, err := s.db.Query(`
		SELECT id, object_key FROM uploads WHERE status = 'pending' AND expires_at < ?
	`, now)
	if err != nil {
		return 0, fmt.Errorf("select expired uploads: %w", err)
	}
	type pending struct{ id, key string }
	var expired []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.id, &p.key); err != nil {
			rows.Close()
			return 0, err
		}
		expired = append(expired, p)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()

	cleaned := 0
	for _, p := range expired {
		if s.blobs != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			_ = s.blobs.Delete(ctx, p.key) // orphan may not exist — ignore
			cancel()
		}
		if _, err := s.db.Exec(`DELETE FROM uploads WHERE id = ?`, p.id); err != nil {
			return cleaned, fmt.Errorf("delete upload %s: %w", p.id, err)
		}
		cleaned++
	}
	return cleaned, nil
}
