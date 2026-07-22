package store

import (
	"errors"
	"time"

	"github.com/google/uuid"
)

type DevicePushToken struct {
	ID                 string
	UserID             string
	Token              string
	Platform           string
	NativeVideoCall    bool
	NativeCallProtocol int
	CreatedAt          int64
}

func (s *Store) UpsertDevicePushToken(userID, token, platform string, nativeVideoCall bool, nativeCallProtocol int) error {
	now := time.Now().UnixMilli()
	_, err := s.db.Exec(`
		INSERT INTO device_push_tokens (id, user_id, token, platform, native_video_call, native_call_protocol, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(token) DO UPDATE SET
			user_id = excluded.user_id,
			platform = excluded.platform,
			native_video_call = excluded.native_video_call,
			native_call_protocol = excluded.native_call_protocol,
			created_at = excluded.created_at
	`, uuid.New().String(), userID, token, platform, boolToInt(nativeVideoCall), nativeCallProtocol, now)
	return err
}

func boolToInt(v bool) int {
	if v {
		return 1
	}
	return 0
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
		SELECT id, user_id, token, platform,
			COALESCE(native_video_call, 0), COALESCE(native_call_protocol, 0), created_at
		FROM device_push_tokens WHERE user_id = ?
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []DevicePushToken
	for rows.Next() {
		var t DevicePushToken
		var nativeInt int
		if err := rows.Scan(
			&t.ID, &t.UserID, &t.Token, &t.Platform,
			&nativeInt, &t.NativeCallProtocol, &t.CreatedAt,
		); err != nil {
			return nil, err
		}
		t.NativeVideoCall = nativeInt != 0
		out = append(out, t)
	}
	return out, rows.Err()
}

// UserHasNativeAndroidCall is true when the user has at least one Android device
// registered with native video-call capability.
func (s *Store) UserHasNativeAndroidCall(userID string) (bool, error) {
	var n int
	err := s.db.QueryRow(`
		SELECT COUNT(1) FROM device_push_tokens
		WHERE user_id = ? AND platform = 'android' AND native_video_call != 0
	`, userID).Scan(&n)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}
