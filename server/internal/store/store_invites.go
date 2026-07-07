package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"time"

	"github.com/google/uuid"

	"coachman/server/internal/db"
)

type InviteInfo struct {
	Token            string `json:"token"`
	InviterUsername  string `json:"inviterUsername"`
	ExpiresAt        *int64 `json:"expiresAt,omitempty"`
}

type InviteGraphNode struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	IsAdmin  bool   `json:"isAdmin"`
}

type InviteGraphEdge struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type InviteGraph struct {
	Nodes []InviteGraphNode `json:"nodes"`
	Edges []InviteGraphEdge `json:"edges"`
}

func (s *Store) UserCount() (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count)
	return count, err
}

func (s *Store) RegisterBootstrapUser(username, publicKey, signingPublicKey string) (*User, error) {
	count, err := s.UserCount()
	if err != nil {
		return nil, err
	}
	if count > 0 {
		return nil, errors.New("bootstrap not allowed")
	}
	return s.insertUser(username, publicKey, signingPublicKey, true, nil, nil)
}

func (s *Store) RegisterInvitedUser(username, publicKey, signingPublicKey, inviteToken string) (*User, error) {
	count, err := s.UserCount()
	if err != nil {
		return nil, err
	}
	if count == 0 {
		return nil, errors.New("bootstrap required")
	}

	invite, inviterID, rootID, err := s.validateInviteToken(inviteToken)
	if err != nil {
		return nil, err
	}

	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	user, err := s.insertUserTx(tx, username, publicKey, signingPublicKey, false, &inviterID, &rootID)
	if err != nil {
		return nil, err
	}

	now := time.Now().UnixMilli()
	res, err := tx.Exec(
		`UPDATE invites SET used_by_user_id = ?, used_at = ? WHERE id = ? AND used_by_user_id IS NULL`,
		user.ID, now, invite.ID,
	)
	if err != nil {
		return nil, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, errors.New("invite already used")
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	_ = s.EnsureCircleDirectChats(user.ID)
	return user, nil
}

func (s *Store) insertUser(username, publicKey, signingPublicKey string, isAdmin bool, invitedBy, rootUserID *string) (*User, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	user, err := s.insertUserTx(tx, username, publicKey, signingPublicKey, isAdmin, invitedBy, rootUserID)
	if err != nil {
		return nil, err
	}
	if isAdmin {
		if _, err := tx.Exec(`UPDATE users SET root_user_id = ? WHERE id = ?`, user.ID, user.ID); err != nil {
			return nil, err
		}
		user.RootUserID = user.ID
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return user, nil
}

func (s *Store) insertUserTx(tx *db.Tx, username, publicKey, signingPublicKey string, isAdmin bool, invitedBy, rootUserID *string) (*User, error) {
	username = NormalizeUsername(username)
	if username == "" {
		return nil, errors.New("username required")
	}
	var exists string
	err := tx.QueryRow(`SELECT id FROM users WHERE lower(username) = lower(?)`, username).Scan(&exists)
	if err == nil {
		return nil, errors.New("username taken")
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}

	id := uuid.New().String()
	now := time.Now().UnixMilli()
	_, err = tx.Exec(
		`INSERT INTO users (id, username, public_key, signing_public_key, created_at, is_admin, invited_by_user_id, root_user_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, username, publicKey, signingPublicKey, now, isAdmin, invitedBy, rootUserID,
	)
	if err != nil {
		return nil, err
	}
	u := &User{ID: id, Username: username, PublicKey: publicKey, IsAdmin: isAdmin}
	if rootUserID != nil {
		u.RootUserID = *rootUserID
	}
	return u, nil
}

type inviteRecord struct {
	ID        string
	Token     string
	CreatedBy string
	ExpiresAt sql.NullInt64
}

func (s *Store) validateInviteToken(token string) (inviteRecord, string, string, error) {
	if token == "" {
		return inviteRecord{}, "", "", errors.New("invalid invite")
	}
	var inv inviteRecord
	var usedBy sql.NullString
	err := s.db.QueryRow(`
		SELECT id, token, created_by_user_id, expires_at, used_by_user_id
		FROM invites WHERE token = ?
	`, token).Scan(&inv.ID, &inv.Token, &inv.CreatedBy, &inv.ExpiresAt, &usedBy)
	if errors.Is(err, sql.ErrNoRows) {
		return inviteRecord{}, "", "", errors.New("invalid invite")
	}
	if err != nil {
		return inviteRecord{}, "", "", err
	}
	if usedBy.Valid {
		return inviteRecord{}, "", "", errors.New("invite already used")
	}
	if inv.ExpiresAt.Valid && time.Now().UnixMilli() > inv.ExpiresAt.Int64 {
		return inviteRecord{}, "", "", errors.New("invite expired")
	}

	var rootID string
	err = s.db.QueryRow(`SELECT COALESCE(root_user_id, id) FROM users WHERE id = ?`, inv.CreatedBy).Scan(&rootID)
	if err != nil {
		return inviteRecord{}, "", "", errors.New("invalid invite")
	}
	return inv, inv.CreatedBy, rootID, nil
}

func (s *Store) ValidateInviteToken(token string) (*InviteInfo, error) {
	inv, inviterID, _, err := s.validateInviteToken(token)
	if err != nil {
		return nil, err
	}
	var username string
	if err := s.db.QueryRow(`SELECT username FROM users WHERE id = ?`, inviterID).Scan(&username); err != nil {
		return nil, errors.New("invalid invite")
	}
	info := &InviteInfo{Token: inv.Token, InviterUsername: username}
	if inv.ExpiresAt.Valid {
		v := inv.ExpiresAt.Int64
		info.ExpiresAt = &v
	}
	return info, nil
}

func (s *Store) CreateInvite(createdBy string, ttlHours int64) (string, error) {
	var exists string
	if err := s.db.QueryRow(`SELECT id FROM users WHERE id = ?`, createdBy).Scan(&exists); err != nil {
		return "", errors.New("user not found")
	}

	tokenBytes := make([]byte, 24)
	if _, err := rand.Read(tokenBytes); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	id := uuid.New().String()
	now := time.Now().UnixMilli()

	var expiresAt *int64
	if ttlHours > 0 {
		v := now + ttlHours*3600*1000
		expiresAt = &v
	}

	_, err := s.db.Exec(
		`INSERT INTO invites (id, token, created_by_user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`,
		id, token, createdBy, expiresAt, now,
	)
	return token, err
}

func (s *Store) IsAdmin(userID string) (bool, error) {
	var admin bool
	err := s.db.QueryRow(`SELECT is_admin FROM users WHERE id = ?`, userID).Scan(&admin)
	if errors.Is(err, sql.ErrNoRows) {
		return false, errors.New("not found")
	}
	return admin, err
}

func (s *Store) getRootUserID(userID string) (string, error) {
	var rootID sql.NullString
	err := s.db.QueryRow(`SELECT root_user_id FROM users WHERE id = ?`, userID).Scan(&rootID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", errors.New("not found")
	}
	if err != nil {
		return "", err
	}
	if rootID.Valid && rootID.String != "" {
		return rootID.String, nil
	}
	return userID, nil
}

func (s *Store) IsMemberOfCircle(viewerID, targetID string) (bool, error) {
	viewerRoot, err := s.getRootUserID(viewerID)
	if err != nil {
		return false, err
	}
	targetRoot, err := s.getRootUserID(targetID)
	if err != nil {
		return false, err
	}
	return viewerRoot == targetRoot, nil
}

func (s *Store) ListCircleUsers(viewerID string) ([]User, error) {
	rootID, err := s.getRootUserID(viewerID)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.Query(
		`SELECT id, username, public_key, is_admin FROM users
		 WHERE COALESCE(root_user_id, id) = ?
		 ORDER BY username ASC`,
		rootID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanUsers(rows)
}

func (s *Store) SearchUsersInCircle(viewerID, query string) ([]User, error) {
	rootID, err := s.getRootUserID(viewerID)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.Query(
		`SELECT id, username, public_key, is_admin FROM users
		 WHERE COALESCE(root_user_id, id) = ? AND username LIKE ?
		 ORDER BY username ASC LIMIT 20`,
		rootID, "%"+query+"%",
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanUsers(rows)
}

func scanUsers(rows *sql.Rows) ([]User, error) {
	var users []User
	for rows.Next() {
		var u User
		var admin bool
		if err := rows.Scan(&u.ID, &u.Username, &u.PublicKey, &admin); err != nil {
			return nil, err
		}
		u.IsAdmin = admin
		users = append(users, u)
	}
	if users == nil {
		users = []User{}
	}
	return users, rows.Err()
}

func (s *Store) GetInviteGraph(adminUserID string) (*InviteGraph, error) {
	isAdmin, err := s.IsAdmin(adminUserID)
	if err != nil {
		return nil, err
	}
	if !isAdmin {
		return nil, errors.New("forbidden")
	}

	rows, err := s.db.Query(`SELECT id, username, is_admin, invited_by_user_id FROM users ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	graph := &InviteGraph{Nodes: []InviteGraphNode{}, Edges: []InviteGraphEdge{}}
	for rows.Next() {
		var id, username string
		var admin bool
		var invitedBy sql.NullString
		if err := rows.Scan(&id, &username, &admin, &invitedBy); err != nil {
			return nil, err
		}
		graph.Nodes = append(graph.Nodes, InviteGraphNode{
			ID: id, Username: username, IsAdmin: admin,
		})
		if invitedBy.Valid {
			graph.Edges = append(graph.Edges, InviteGraphEdge{From: invitedBy.String, To: id})
		}
	}
	return graph, rows.Err()
}
