package store

import (
	"database/sql"
	"errors"
	"time"
)

// AdminKeyBackup is an opaque client-encrypted blob of the admin's device keys.
// The server never sees private key material in plaintext.
type AdminKeyBackup struct {
	UserID     string `json:"userId"`
	Salt       string `json:"salt"`
	IV         string `json:"iv"`
	Ciphertext string `json:"ciphertext"`
	Version    int    `json:"version"`
	UpdatedAt  int64  `json:"updatedAt"`
}

func (s *Store) GetAdminUserID() (string, error) {
	var id string
	err := s.db.QueryRow(`SELECT id FROM users WHERE is_admin = ? LIMIT 1`, true).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", errors.New("admin not found")
	}
	return id, err
}

func (s *Store) HasAdminKeyBackup() (bool, error) {
	adminID, err := s.GetAdminUserID()
	if err != nil {
		if err.Error() == "admin not found" {
			return false, nil
		}
		return false, err
	}
	var n int
	err = s.db.QueryRow(`SELECT COUNT(1) FROM admin_key_backup WHERE user_id = ?`, adminID).Scan(&n)
	if err != nil {
		// Table may be missing on a partially migrated test DB.
		return false, nil
	}
	return n > 0, nil
}

func (s *Store) GetAdminKeyBackup() (*AdminKeyBackup, error) {
	adminID, err := s.GetAdminUserID()
	if err != nil {
		return nil, err
	}
	var b AdminKeyBackup
	err = s.db.QueryRow(
		`SELECT user_id, salt, iv, ciphertext, version, updated_at FROM admin_key_backup WHERE user_id = ?`,
		adminID,
	).Scan(&b.UserID, &b.Salt, &b.IV, &b.Ciphertext, &b.Version, &b.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("not found")
	}
	if err != nil {
		return nil, err
	}
	return &b, nil
}

func (s *Store) UpsertAdminKeyBackup(userID, salt, iv, ciphertext string, version int) error {
	if userID == "" || salt == "" || iv == "" || ciphertext == "" {
		return errors.New("backup fields required")
	}
	adminID, err := s.GetAdminUserID()
	if err != nil {
		return err
	}
	if userID != adminID {
		return errors.New("forbidden")
	}
	if version <= 0 {
		version = 1
	}
	now := time.Now().UnixMilli()
	_, err = s.db.Exec(
		`INSERT INTO admin_key_backup (user_id, salt, iv, ciphertext, version, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET
		   salt = excluded.salt,
		   iv = excluded.iv,
		   ciphertext = excluded.ciphertext,
		   version = excluded.version,
		   updated_at = excluded.updated_at`,
		userID, salt, iv, ciphertext, version, now,
	)
	return err
}

func (s *Store) DeleteAdminKeyBackup(userID string) error {
	_, err := s.db.Exec(`DELETE FROM admin_key_backup WHERE user_id = ?`, userID)
	return err
}
