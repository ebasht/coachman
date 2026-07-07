package store

import (
	"errors"
	"time"

	"github.com/google/uuid"
)

type PushSubscription struct {
	ID        string
	UserID    string
	Endpoint  string
	P256dh    string
	AuthKey   string
	CreatedAt int64
}

func (s *Store) UpsertPushSubscription(userID, endpoint, p256dh, authKey string) error {
	now := time.Now().UnixMilli()
	_, err := s.db.Exec(`
		INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth_key, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(endpoint) DO UPDATE SET
			user_id = excluded.user_id,
			p256dh = excluded.p256dh,
			auth_key = excluded.auth_key
	`, uuid.New().String(), userID, endpoint, p256dh, authKey, now)
	return err
}

func (s *Store) DeletePushSubscription(userID, endpoint string) error {
	res, err := s.db.Exec(`DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`, userID, endpoint)
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

func (s *Store) DeletePushSubscriptionsByEndpoint(endpoint string) error {
	_, err := s.db.Exec(`DELETE FROM push_subscriptions WHERE endpoint = ?`, endpoint)
	return err
}

func (s *Store) ListPushSubscriptions(userID string) ([]PushSubscription, error) {
	rows, err := s.db.Query(`
		SELECT id, user_id, endpoint, p256dh, auth_key, created_at
		FROM push_subscriptions WHERE user_id = ?
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var subs []PushSubscription
	for rows.Next() {
		var sub PushSubscription
		if err := rows.Scan(&sub.ID, &sub.UserID, &sub.Endpoint, &sub.P256dh, &sub.AuthKey, &sub.CreatedAt); err != nil {
			return nil, err
		}
		subs = append(subs, sub)
	}
	return subs, rows.Err()
}
