package store

import (
	"database/sql"
	"errors"

	"coachman/server/internal/db"
)

func (s *Store) ResetAllData() error {
	if s.db.Driver == db.DriverPostgres {
		_, err := s.db.Exec(`
			TRUNCATE TABLE
				auth_challenges,
				chat_read_state,
				push_subscriptions,
				hidden_direct_chats,
				invites,
				messages,
				images,
				chat_members,
				chats,
				users
			CASCADE
		`)
		return err
	}
	tables := []string{
		"auth_challenges",
		"chat_read_state",
		"push_subscriptions",
		"hidden_direct_chats",
		"invites",
		"messages",
		"images",
		"chat_members",
		"chats",
		"users",
	}
	for _, table := range tables {
		if _, err := s.db.Exec(`DELETE FROM ` + table); err != nil {
			// table may not exist in older test DBs
			continue
		}
	}
	return nil
}

func (s *Store) SetUserLastSeen(userID string, at int64) error {
	_, err := s.db.Exec(`UPDATE users SET last_seen_at = ? WHERE id = ?`, at, userID)
	return err
}

func (s *Store) GetUserLastSeen(userID string) (*int64, error) {
	var at sql.NullInt64
	err := s.db.QueryRow(`SELECT last_seen_at FROM users WHERE id = ?`, userID).Scan(&at)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("not found")
	}
	if err != nil {
		return nil, err
	}
	if !at.Valid {
		return nil, nil
	}
	v := at.Int64
	return &v, nil
}

// GetSharedChatPeerIDs returns user IDs that share at least one chat with userID.
func (s *Store) GetSharedChatPeerIDs(userID string) ([]string, error) {
	rows, err := s.db.Query(`
		SELECT DISTINCT cm2.user_id
		FROM chat_members cm1
		JOIN chat_members cm2 ON cm2.chat_id = cm1.chat_id AND cm2.user_id != cm1.user_id
		WHERE cm1.user_id = ?
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// GetUsersLastSeen returns last_seen_at for the given user IDs.
func (s *Store) GetUsersLastSeen(userIDs []string) (map[string]int64, error) {
	out := make(map[string]int64, len(userIDs))
	if len(userIDs) == 0 {
		return out, nil
	}
	for _, id := range userIDs {
		at, err := s.GetUserLastSeen(id)
		if err != nil {
			if err.Error() == "not found" {
				continue
			}
			return nil, err
		}
		if at != nil {
			out[id] = *at
		}
	}
	return out, nil
}
