package store

func (s *Store) IncrementPushBadge(userID string) (int, error) {
	var badge int
	err := s.db.QueryRow(
		`UPDATE users SET push_badge = push_badge + 1 WHERE id = ? RETURNING push_badge`,
		userID,
	).Scan(&badge)
	if err != nil {
		return 1, err
	}
	if badge < 1 {
		return 1, nil
	}
	return badge, nil
}

func (s *Store) ResetPushBadge(userID string) error {
	_, err := s.db.Exec(`UPDATE users SET push_badge = 0 WHERE id = ?`, userID)
	return err
}
