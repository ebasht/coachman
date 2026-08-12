package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"time"

	"github.com/google/uuid"
)

const loginRecoveryTTL = 15 * time.Minute

// GetAdminPublicKey returns the ECDH public key of the current admin (for key escrow).
func (s *Store) GetAdminPublicKey() (string, error) {
	var pub string
	err := s.db.QueryRow(
		`SELECT public_key FROM users WHERE is_admin = ? ORDER BY created_at ASC LIMIT 1`,
		true,
	).Scan(&pub)
	if errors.Is(err, sql.ErrNoRows) {
		return "", errors.New("admin not found")
	}
	return pub, err
}

// UpsertUserKeyBackup stores an opaque ciphertext of the user's private keys (admin-wrapped).
func (s *Store) UpsertUserKeyBackup(userID, ciphertext string) error {
	if userID == "" || ciphertext == "" {
		return errors.New("backup required")
	}
	if len(ciphertext) > 64<<10 {
		return errors.New("backup too large")
	}
	now := time.Now().UnixMilli()
	_, err := s.db.Exec(`
		INSERT INTO user_key_backups (user_id, ciphertext, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(user_id) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at
	`, userID, ciphertext, now)
	return err
}

// GetUserKeyBackup returns escrow ciphertext for a user. Admin-only.
func (s *Store) GetUserKeyBackup(adminID, targetUserID string) (string, error) {
	isAdmin, err := s.IsAdmin(adminID)
	if err != nil {
		return "", err
	}
	if !isAdmin {
		return "", errors.New("forbidden")
	}
	var ciphertext string
	err = s.db.QueryRow(
		`SELECT ciphertext FROM user_key_backups WHERE user_id = ?`,
		targetUserID,
	).Scan(&ciphertext)
	if errors.Is(err, sql.ErrNoRows) {
		return "", errors.New("backup not found")
	}
	return ciphertext, err
}

// HasUserKeyBackup reports whether a backup exists.
func (s *Store) HasUserKeyBackup(userID string) (bool, error) {
	var one int
	err := s.db.QueryRow(`SELECT 1 FROM user_key_backups WHERE user_id = ?`, userID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

type LoginRecoverySession struct {
	Token      string `json:"token"`
	UserID     string `json:"userId"`
	Username   string `json:"username"`
	ExpiresAt  int64  `json:"expiresAt"`
	Ciphertext string `json:"ciphertext,omitempty"`
	PublicKey  string `json:"publicKey,omitempty"`
	SigningPublicKey string `json:"signingPublicKey,omitempty"`
}

// CreateLoginRecovery creates a one-time recovery token with admin-provided wrapped key material.
func (s *Store) CreateLoginRecovery(adminID, targetUserID, ciphertext string) (*LoginRecoverySession, error) {
	isAdmin, err := s.IsAdmin(adminID)
	if err != nil {
		return nil, err
	}
	if !isAdmin {
		return nil, errors.New("forbidden")
	}
	if ciphertext == "" {
		return nil, errors.New("ciphertext required")
	}
	if len(ciphertext) > 64<<10 {
		return nil, errors.New("ciphertext too large")
	}

	var username string
	var publicKey string
	err = s.db.QueryRow(
		`SELECT username, public_key FROM users WHERE id = ?`,
		targetUserID,
	).Scan(&username, &publicKey)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("user not found")
	}
	if err != nil {
		return nil, err
	}

	tokenBytes := make([]byte, 24)
	if _, err := rand.Read(tokenBytes); err != nil {
		return nil, err
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	id := uuid.New().String()
	now := time.Now()
	expiresAt := now.Add(loginRecoveryTTL).UnixMilli()

	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	// Only one active recovery link per user.
	if _, err := tx.Exec(
		`DELETE FROM login_recovery_tokens WHERE user_id = ? AND used_at IS NULL`,
		targetUserID,
	); err != nil {
		return nil, err
	}

	if _, err := tx.Exec(`
		INSERT INTO login_recovery_tokens
			(id, token, user_id, ciphertext, created_by_user_id, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`, id, token, targetUserID, ciphertext, adminID, expiresAt, now.UnixMilli()); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}

	return &LoginRecoverySession{
		Token:     token,
		UserID:    targetUserID,
		Username:  username,
		ExpiresAt: expiresAt,
	}, nil
}

// ConsumeLoginRecovery returns wrapped keys and marks the token used (one-time).
// Also bumps token_version so sessions on other devices are invalidated.
func (s *Store) ConsumeLoginRecovery(token string) (*LoginRecoverySession, error) {
	if token == "" {
		return nil, errors.New("invalid recovery")
	}

	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var (
		id, userID, ciphertext string
		expiresAt              int64
		usedAt                 sql.NullInt64
	)
	err = tx.QueryRow(`
		SELECT id, user_id, ciphertext, expires_at, used_at
		FROM login_recovery_tokens WHERE token = ?
	`, token).Scan(&id, &userID, &ciphertext, &expiresAt, &usedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("invalid recovery")
	}
	if err != nil {
		return nil, err
	}
	if usedAt.Valid {
		return nil, errors.New("recovery already used")
	}
	now := time.Now().UnixMilli()
	if now > expiresAt {
		return nil, errors.New("recovery expired")
	}

	res, err := tx.Exec(
		`UPDATE login_recovery_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL`,
		now, id,
	)
	if err != nil {
		return nil, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, errors.New("recovery already used")
	}

	var username, publicKey string
	var signingPublicKey sql.NullString
	err = tx.QueryRow(
		`SELECT username, public_key, signing_public_key FROM users WHERE id = ?`,
		userID,
	).Scan(&username, &publicKey, &signingPublicKey)
	if err != nil {
		return nil, err
	}

	if _, err := tx.Exec(
		`UPDATE users SET token_version = token_version + 1 WHERE id = ?`,
		userID,
	); err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	session := &LoginRecoverySession{
		Token:      token,
		UserID:     userID,
		Username:   username,
		ExpiresAt:  expiresAt,
		Ciphertext: ciphertext,
		PublicKey:  publicKey,
	}
	if signingPublicKey.Valid {
		session.SigningPublicKey = signingPublicKey.String
	}
	return session, nil
}

// PeekLoginRecovery validates a token without consuming it (for UI preview).
func (s *Store) PeekLoginRecovery(token string) (*LoginRecoverySession, error) {
	if token == "" {
		return nil, errors.New("invalid recovery")
	}
	var userID string
	var expiresAt int64
	var usedAt sql.NullInt64
	err := s.db.QueryRow(`
		SELECT user_id, expires_at, used_at FROM login_recovery_tokens WHERE token = ?
	`, token).Scan(&userID, &expiresAt, &usedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("invalid recovery")
	}
	if err != nil {
		return nil, err
	}
	if usedAt.Valid {
		return nil, errors.New("recovery already used")
	}
	if time.Now().UnixMilli() > expiresAt {
		return nil, errors.New("recovery expired")
	}
	var username string
	if err := s.db.QueryRow(`SELECT username FROM users WHERE id = ?`, userID).Scan(&username); err != nil {
		return nil, errors.New("invalid recovery")
	}
	return &LoginRecoverySession{
		Token:     token,
		UserID:    userID,
		Username:  username,
		ExpiresAt: expiresAt,
	}, nil
}
