package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

var (
	ErrUnsupportedVideoType = errors.New("unsupported video type")
	ErrVideoTooLarge        = errors.New("video too large")
)

// videoContentTypes maps accepted MIME → file extension.
var videoContentTypes = map[string]string{
	"video/mp4":       "mp4",
	"video/webm":      "webm",
	"video/quicktime": "mov",
}

func videoExtension(contentType string) (string, bool) {
	ext, ok := videoContentTypes[strings.ToLower(strings.TrimSpace(contentType))]
	return ext, ok
}

func (s *Store) videoMaxBytes() int64 {
	if s.videoMaxSize > 0 {
		return s.videoMaxSize
	}
	return 100 << 20 // 100 MB default
}

// InitVideoUpload issues a presigned PUT for a chat video (same uploads table as photos).
func (s *Store) InitVideoUpload(userID, chatID, contentType string, size int64, fileName string) (*PhotoUpload, error) {
	du, ok := s.uploader()
	if !ok {
		return nil, ErrDirectUploadUnavailable
	}
	ext, ok := videoExtension(contentType)
	if !ok {
		return nil, ErrUnsupportedVideoType
	}
	if size <= 0 || size > s.videoMaxBytes() {
		return nil, ErrVideoTooLarge
	}

	now := time.Now()
	id := uuid.New().String()
	key := fmt.Sprintf("chats/%s/%04d/%02d/%s.%s", chatID, now.Year(), int(now.Month()), uuid.New().String(), ext)

	ttl := s.photoUploadTTL
	if ttl <= 0 {
		ttl = 15 * time.Minute
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

// CompleteVideoUpload verifies the object and records an attachment with type=video.
func (s *Store) CompleteVideoUpload(userID, uploadID string, width, height int) (*Attachment, error) {
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

	if status == "completed" && imageID.Valid {
		att, err := s.attachmentByImageID(du, imageID.String)
		if err == nil {
			att.Type = "video"
			return att, nil
		}
	}
	if status != "pending" && status != "completed" {
		return nil, ErrUploadNotPending
	}
	if status == "pending" && time.Now().UnixMilli() > expiresAt {
		_, _ = s.db.Exec(`UPDATE uploads SET status = 'failed' WHERE id = ?`, uploadID)
		return nil, ErrUploadExpired
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	stat, err := du.Stat(ctx, objectKey)
	if err != nil {
		_, _ = s.db.Exec(`UPDATE uploads SET status = 'failed' WHERE id = ?`, uploadID)
		return nil, ErrUploadObjectMissing
	}
	if stat.Size <= 0 || stat.Size > s.videoMaxBytes() {
		_, _ = s.db.Exec(`UPDATE uploads SET status = 'failed' WHERE id = ?`, uploadID)
		return nil, ErrVideoTooLarge
	}
	if expectedSize > 0 && stat.Size > expectedSize+256*1024 {
		_, _ = s.db.Exec(`UPDATE uploads SET status = 'failed' WHERE id = ?`, uploadID)
		return nil, ErrUploadSizeMismatch
	}

	actualType := stat.ContentType
	if actualType == "" {
		actualType = contentType
	}
	// Some S3 backends return application/octet-stream — fall back to declared type.
	if _, ok := videoExtension(actualType); !ok {
		if _, ok := videoExtension(contentType); ok {
			actualType = contentType
		} else {
			_, _ = s.db.Exec(`UPDATE uploads SET status = 'failed' WHERE id = ?`, uploadID)
			return nil, ErrUnsupportedVideoType
		}
	}

	newImageID := uuid.New().String()
	createdAt := time.Now().UnixMilli()
	if _, err := s.db.Exec(`
		INSERT INTO images (id, chat_id, uploader_id, ciphertext, iv, mime_type, created_at, storage_key, size_bytes, width, height)
		VALUES (?, ?, ?, ?, 'plain', ?, ?, ?, ?, ?, ?)
	`, newImageID, chatID, userID, []byte{}, actualType, createdAt, objectKey, stat.Size, width, height); err != nil {
		return nil, fmt.Errorf("record video: %w", err)
	}
	if _, err := s.db.Exec(`UPDATE uploads SET status = 'completed', image_id = ? WHERE id = ?`, newImageID, uploadID); err != nil {
		return nil, fmt.Errorf("finalize upload: %w", err)
	}

	url, _ := s.photoDownloadURL(du, objectKey)
	return &Attachment{
		ID:        newImageID,
		Type:      "video",
		MimeType:  actualType,
		Size:      stat.Size,
		Width:     width,
		Height:    height,
		ObjectKey: objectKey,
		URL:       url,
	}, nil
}

func attachmentTypeFromMIME(mimeType string) string {
	if strings.HasPrefix(strings.ToLower(mimeType), "video/") {
		return "video"
	}
	return "image"
}
