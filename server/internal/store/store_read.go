package store

import "errors"

func (s *Store) SetChatReadAt(chatID, userID string, at int64) error {
	if at < 0 {
		return errors.New("invalid read time")
	}
	member, err := s.IsMember(chatID, userID)
	if err != nil {
		return err
	}
	if !member {
		return errors.New("forbidden")
	}
	_, err = s.db.Exec(`
		INSERT INTO chat_read_state (chat_id, user_id, last_read_at) VALUES (?, ?, ?)
		ON CONFLICT(chat_id, user_id) DO UPDATE SET
			last_read_at = CASE
				WHEN excluded.last_read_at > chat_read_state.last_read_at THEN excluded.last_read_at
				ELSE chat_read_state.last_read_at
			END
	`, chatID, userID, at)
	return err
}

func (s *Store) GetPeerLastReadAt(chatID, userID string) (int64, error) {
	var at int64
	err := s.db.QueryRow(`
		SELECT COALESCE(MAX(last_read_at), 0)
		FROM chat_read_state
		WHERE chat_id = ? AND user_id != ?
	`, chatID, userID).Scan(&at)
	return at, err
}
