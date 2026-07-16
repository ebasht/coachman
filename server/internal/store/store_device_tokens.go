package store

import (
	"errors"
	"time"

	"github.com/google/uuid"
)

type DevicePushToken struct {
	ID        string
	UserID    string
	Token     string
	Platform  string
	CreatedAt int64
}

func (s *Store) UpsertDevicePushToken(userID, token, platform string) error {
	now := time.Now().UnixMilli()
	_, err := s.db.Exec(`
		INSERT INTO device_push_tokens (id, user_id, token, platform, created_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(token) DO UPDATE SET
			user_id = excluded.user_id,
			platform = excluded.platform,
			created_at = excluded.created_at
	`, uuid.New().String(), userID, token, platform, now)
	return err
}

func (s *Store) DeleteDevicePushToken(userID, token string) error {
	res, err := s.db.Exec(`DELETE FROM device_push_tokens WHERE user_id = ? AND token = ?`, userID, token)
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
	return nil
}

func (s *Store) DeleteDevicePushTokenByToken(token string) error {
	_, err := s.db.Exec(`DELETE FROM device_push_tokens WHERE token = ?`, token)
	return err
}

func (s *Store) ListDevicePushTokens(userID string) ([]DevicePushToken, error) {
	rows, err := s.db.Query(`
		SELECT id, user_id, token, platform, created_at
		FROM device_push_tokens WHERE user_id = ?
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []DevicePushToken
	for rows.Next() {
		var t DevicePushToken
		if err := rows.Scan(&t.ID, &t.UserID, &t.Token, &t.Platform, &t.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}
