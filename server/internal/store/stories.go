package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"coachman/server/internal/blob"
)

const (
	StoryTTL        = 24 * time.Hour
	MaxActiveStories = 30
	maxStoryBytes    = 12 << 20 // 12 MiB
)

var (
	ErrStoryNotFound   = errors.New("story not found")
	ErrStoryForbidden  = errors.New("story forbidden")
	ErrStoryExpired    = errors.New("story expired")
	ErrStoryLimit      = errors.New("story limit reached")
	ErrStoryBadImage   = errors.New("unsupported story image")
)

type StoryItem struct {
	ID        string `json:"id"`
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt int64  `json:"expiresAt"`
	URL       string `json:"url,omitempty"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Seen      bool   `json:"seen"`
}

type StoryAuthor struct {
	UserID          string      `json:"userId"`
	Username        string      `json:"username"`
	HasAvatar       bool        `json:"hasAvatar"`
	AvatarUpdatedAt *int64      `json:"avatarUpdatedAt,omitempty"`
	AvatarURL       *string     `json:"avatarUrl,omitempty"`
	HasUnseen       bool        `json:"hasUnseen"`
	LatestAt        int64       `json:"latestAt"`
	IsMe            bool        `json:"isMe"`
	Stories         []StoryItem `json:"stories"`
}

func storyMIMEAllowed(mime string) bool {
	switch strings.ToLower(mime) {
	case "image/jpeg", "image/png", "image/webp":
		return true
	default:
		return false
	}
}

// CreateStory stores a photo story visible to the author's invite circle for 24h.
func (s *Store) CreateStory(userID, mimeType string, data []byte, width, height int) (*StoryItem, error) {
	if len(data) == 0 || int64(len(data)) > maxStoryBytes {
		return nil, ErrPhotoTooLarge
	}
	if !storyMIMEAllowed(mimeType) {
		return nil, ErrStoryBadImage
	}
	if s.blobs == nil {
		return nil, errors.New("blob storage unavailable")
	}

	now := time.Now()
	nowMs := now.UnixMilli()
	var active int
	if err := s.db.QueryRow(
		`SELECT COUNT(*) FROM stories WHERE user_id = ? AND expires_at > ?`,
		userID, nowMs,
	).Scan(&active); err != nil {
		return nil, err
	}
	if active >= MaxActiveStories {
		return nil, ErrStoryLimit
	}

	ext := "jpg"
	switch mimeType {
	case "image/png":
		ext = "png"
	case "image/webp":
		ext = "webp"
	}
	id := uuid.New().String()
	key := fmt.Sprintf("stories/%s/%04d/%02d/%s.%s", userID, now.Year(), int(now.Month()), id, ext)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := s.blobs.PutWithOptions(ctx, key, data, blob.PutOptions{ContentType: mimeType}); err != nil {
		return nil, fmt.Errorf("put story: %w", err)
	}

	expiresAt := now.Add(StoryTTL).UnixMilli()
	if _, err := s.db.Exec(`
		INSERT INTO stories (id, user_id, storage_key, mime_type, size_bytes, width, height, created_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, id, userID, key, mimeType, len(data), width, height, nowMs, expiresAt); err != nil {
		_ = s.blobs.Delete(context.Background(), key)
		return nil, err
	}

	url, _ := s.storyDownloadURL(key)
	return &StoryItem{
		ID:        id,
		CreatedAt: nowMs,
		ExpiresAt: expiresAt,
		URL:       url,
		Width:     width,
		Height:    height,
		Seen:      true,
	}, nil
}

func (s *Store) storyDownloadURL(key string) (string, error) {
	du, ok := s.uploader()
	if !ok {
		return "", ErrDirectUploadUnavailable
	}
	ttl := s.photoDownloadTTL
	if ttl <= 0 {
		ttl = 15 * time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return du.PresignGet(ctx, key, ttl)
}

// ListStoryFeed returns circle authors who currently have unexpired stories.
// Current user is always first (even with zero stories, so the client can show "Add").
func (s *Store) ListStoryFeed(viewerID string) ([]StoryAuthor, error) {
	now := time.Now().UnixMilli()
	circle, err := s.ListCircleUsers(viewerID)
	if err != nil {
		return nil, err
	}

	out := make([]StoryAuthor, 0, len(circle))
	var me *StoryAuthor

	for _, u := range circle {
		items, err := s.listUserStories(viewerID, u.ID, now)
		if err != nil {
			return nil, err
		}
		isMe := u.ID == viewerID
		if len(items) == 0 && !isMe {
			continue
		}
		hasUnseen := false
		latest := int64(0)
		for _, it := range items {
			if !it.Seen {
				hasUnseen = true
			}
			if it.CreatedAt > latest {
				latest = it.CreatedAt
			}
		}
		author := StoryAuthor{
			UserID:    u.ID,
			Username:  u.Username,
			HasAvatar: u.HasAvatar,
			HasUnseen: hasUnseen,
			LatestAt:  latest,
			IsMe:      isMe,
			Stories:   items,
		}
		if u.AvatarUpdatedAt != nil {
			author.AvatarUpdatedAt = u.AvatarUpdatedAt
		}
		if u.AvatarURL != "" {
			url := u.AvatarURL
			author.AvatarURL = &url
		}
		if isMe {
			cp := author
			me = &cp
			continue
		}
		out = append(out, author)
	}

	// Unseen first, then by latest activity.
	for i := 0; i < len(out); i++ {
		for j := i + 1; j < len(out); j++ {
			ai, aj := out[i], out[j]
			if aj.HasUnseen != ai.HasUnseen {
				if aj.HasUnseen {
					out[i], out[j] = out[j], out[i]
				}
				continue
			}
			if aj.LatestAt > ai.LatestAt {
				out[i], out[j] = out[j], out[i]
			}
		}
	}

	if me == nil {
		// Viewer missing from circle list (shouldn't happen) — still expose empty "me".
		me = &StoryAuthor{UserID: viewerID, IsMe: true, Stories: []StoryItem{}}
		if u, err := s.GetUser(viewerID); err == nil && u != nil {
			me.Username = u.Username
			me.HasAvatar = u.HasAvatar
			me.AvatarUpdatedAt = u.AvatarUpdatedAt
			if u.AvatarURL != "" {
				url := u.AvatarURL
				me.AvatarURL = &url
			}
		}
	}
	if me.Stories == nil {
		me.Stories = []StoryItem{}
	}
	return append([]StoryAuthor{*me}, out...), nil
}

func (s *Store) listUserStories(viewerID, authorID string, now int64) ([]StoryItem, error) {
	rows, err := s.db.Query(`
		SELECT s.id, s.storage_key, s.width, s.height, s.created_at, s.expires_at,
			CASE WHEN v.viewer_id IS NULL THEN 0 ELSE 1 END AS seen
		FROM stories s
		LEFT JOIN story_views v ON v.story_id = s.id AND v.viewer_id = ?
		WHERE s.user_id = ? AND s.expires_at > ?
		ORDER BY s.created_at ASC
	`, viewerID, authorID, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var items []StoryItem
	for rows.Next() {
		var it StoryItem
		var key string
		var seenInt int
		if err := rows.Scan(&it.ID, &key, &it.Width, &it.Height, &it.CreatedAt, &it.ExpiresAt, &seenInt); err != nil {
			return nil, err
		}
		it.Seen = seenInt == 1 || authorID == viewerID
		if url, err := s.storyDownloadURL(key); err == nil {
			it.URL = url
		}
		items = append(items, it)
	}
	if items == nil {
		items = []StoryItem{}
	}
	return items, rows.Err()
}

func (s *Store) MarkStoryViewed(viewerID, storyID string) error {
	now := time.Now().UnixMilli()
	var authorID string
	var expiresAt int64
	err := s.db.QueryRow(
		`SELECT user_id, expires_at FROM stories WHERE id = ?`, storyID,
	).Scan(&authorID, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrStoryNotFound
	}
	if err != nil {
		return err
	}
	if now > expiresAt {
		return ErrStoryExpired
	}
	ok, err := s.IsMemberOfCircle(viewerID, authorID)
	if err != nil {
		return err
	}
	if !ok {
		return ErrStoryForbidden
	}
	_, err = s.db.Exec(`
		INSERT INTO story_views (story_id, viewer_id, viewed_at) VALUES (?, ?, ?)
		ON CONFLICT (story_id, viewer_id) DO NOTHING
	`, storyID, viewerID, now)
	return err
}

func (s *Store) DeleteStory(userID, storyID string) error {
	var key string
	var owner string
	err := s.db.QueryRow(`SELECT user_id, storage_key FROM stories WHERE id = ?`, storyID).Scan(&owner, &key)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrStoryNotFound
	}
	if err != nil {
		return err
	}
	if owner != userID {
		return ErrStoryForbidden
	}
	if _, err := s.db.Exec(`DELETE FROM stories WHERE id = ?`, storyID); err != nil {
		return err
	}
	if s.blobs != nil && key != "" {
		_ = s.blobs.Delete(context.Background(), key)
	}
	return nil
}

// CleanupExpiredStories deletes expired rows and best-effort removes blob objects.
func (s *Store) CleanupExpiredStories(now int64) (int, error) {
	rows, err := s.db.Query(`SELECT id, storage_key FROM stories WHERE expires_at <= ?`, now)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	type row struct {
		id  string
		key string
	}
	var doomed []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.key); err != nil {
			return 0, err
		}
		doomed = append(doomed, r)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if len(doomed) == 0 {
		return 0, nil
	}

	for _, r := range doomed {
		if _, err := s.db.Exec(`DELETE FROM stories WHERE id = ?`, r.id); err != nil {
			return 0, err
		}
		if s.blobs != nil && r.key != "" {
			_ = s.blobs.Delete(context.Background(), r.key)
		}
	}
	return len(doomed), nil
}
