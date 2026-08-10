package store

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"time"

	"coachman/server/internal/blob"
)

// CanSetChatAvatar: system group → admin; user group → creator. Direct chats: no.
func (s *Store) CanSetChatAvatar(actorID, chatID string) (bool, error) {
	var chatType string
	var isSystem bool
	var createdBy sql.NullString
	err := s.db.QueryRow(
		`SELECT type, is_system, created_by_user_id FROM chats WHERE id = ?`, chatID,
	).Scan(&chatType, &isSystem, &createdBy)
	if errors.Is(err, sql.ErrNoRows) {
		return false, errors.New("not found")
	}
	if err != nil {
		return false, err
	}
	if chatType != "group" {
		return false, nil
	}
	member, err := s.IsMember(chatID, actorID)
	if err != nil {
		return false, err
	}
	if !member {
		return false, nil
	}
	if isSystem {
		return s.IsAdmin(actorID)
	}
	return createdBy.Valid && createdBy.String == actorID, nil
}

func (s *Store) SetChatAvatar(actorID, chatID, mimeType string, data []byte) (updatedAt int64, avatarURL string, err error) {
	ok, err := s.CanSetChatAvatar(actorID, chatID)
	if err != nil {
		return 0, "", err
	}
	if !ok {
		return 0, "", errors.New("forbidden")
	}

	now := time.Now().UnixMilli()
	var oldKey sql.NullString
	_ = s.db.QueryRow(`SELECT avatar_key FROM chats WHERE id = ?`, chatID).Scan(&oldKey)

	if s.blobs != nil {
		key := "avatars/chats/" + chatID + "/" + strconv.FormatInt(now, 10) + "." + avatarExt(mimeType)
		if err := s.blobs.PutWithOptions(context.Background(), key, data, blob.PutOptions{
			ContentType:  mimeType,
			CacheControl: "public, max-age=31536000",
			PublicRead:   true,
		}); err != nil {
			return 0, "", err
		}
		res, err := s.db.Exec(
			`UPDATE chats SET avatar_key = ?, avatar_mime = ?, avatar_updated_at = ?, avatar_data = NULL WHERE id = ?`,
			key, mimeType, now, chatID,
		)
		if err != nil {
			_ = s.blobs.Delete(context.Background(), key)
			return 0, "", err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return 0, "", err
		}
		if n == 0 {
			_ = s.blobs.Delete(context.Background(), key)
			return 0, "", errors.New("not found")
		}
		if oldKey.Valid && oldKey.String != "" && oldKey.String != key {
			_ = s.blobs.Delete(context.Background(), oldKey.String)
		}
		return now, s.buildAvatarURL(key, now), nil
	}

	res, err := s.db.Exec(
		`UPDATE chats SET avatar_data = ?, avatar_mime = ?, avatar_updated_at = ?, avatar_key = NULL WHERE id = ?`,
		data, mimeType, now, chatID,
	)
	if err != nil {
		return 0, "", err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, "", err
	}
	if n == 0 {
		return 0, "", errors.New("not found")
	}
	return now, "", nil
}

func (s *Store) ClearChatAvatar(actorID, chatID string) error {
	ok, err := s.CanSetChatAvatar(actorID, chatID)
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("forbidden")
	}

	var oldKey sql.NullString
	err = s.db.QueryRow(`SELECT avatar_key FROM chats WHERE id = ?`, chatID).Scan(&oldKey)
	if errors.Is(err, sql.ErrNoRows) {
		return errors.New("not found")
	}
	if err != nil {
		return err
	}

	res, err := s.db.Exec(
		`UPDATE chats SET avatar_data = NULL, avatar_mime = NULL, avatar_updated_at = NULL, avatar_key = NULL WHERE id = ?`,
		chatID,
	)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return errors.New("not found")
	}
	if oldKey.Valid && oldKey.String != "" && s.blobs != nil {
		_ = s.blobs.Delete(context.Background(), oldKey.String)
	}
	return nil
}

func (s *Store) GetChatAvatar(chatID string) (data []byte, mimeType string, updatedAt int64, err error) {
	var mime sql.NullString
	var updated sql.NullInt64
	var key sql.NullString
	var blobData []byte
	err = s.db.QueryRow(
		`SELECT avatar_data, avatar_mime, avatar_updated_at, avatar_key FROM chats WHERE id = ?`, chatID,
	).Scan(&blobData, &mime, &updated, &key)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, "", 0, errors.New("not found")
	}
	if err != nil {
		return nil, "", 0, err
	}
	if !mime.Valid || !updated.Valid {
		return nil, "", 0, errors.New("not found")
	}
	if key.Valid && key.String != "" {
		if s.blobs == nil {
			return nil, "", 0, errors.New("not found")
		}
		data, err = s.blobs.Get(context.Background(), key.String)
		if err != nil {
			return nil, "", 0, errors.New("not found")
		}
		return data, mime.String, updated.Int64, nil
	}
	if len(blobData) == 0 {
		return nil, "", 0, errors.New("not found")
	}
	return blobData, mime.String, updated.Int64, nil
}
